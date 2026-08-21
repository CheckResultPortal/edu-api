import { Injectable } from '@nestjs/common';

import type {
  DatabaseClient,
  DatabaseTransactionClient,
} from '@edu-api/database';
import { assertValidOutboxEvent } from '@edu-api/outbox';

import type {
  StockMonitoringRunResult,
  StockMonitoringService,
} from '../application/stock-monitoring-service';
import {
  stockLevelFor,
  transitionStockMonitoringState,
  type StockAlertEventType,
  type StockLevel,
} from '../domain/stock-monitoring-transition';

type EvaluationOutcome =
  | { readonly kind: 'EVALUATED'; readonly raisedAlert: boolean }
  | { readonly kind: 'PASS_COMPLETED' }
  | { readonly kind: 'SKIPPED' };

interface ProductMetrics {
  readonly availableStock: bigint;
  readonly lowStockThreshold: number;
  readonly oldestWaitingPaidAt: Date | null;
  readonly paidWaitingQuantity: bigint;
  readonly productId: bigint;
  readonly productPublicId: string;
  readonly soldToday: bigint;
}

@Injectable()
export class PrismaStockMonitoringService implements StockMonitoringService {
  constructor(private readonly database: DatabaseClient) {}

  async processAvailable(
    maximumProducts: number,
  ): Promise<StockMonitoringRunResult> {
    const limit = boundedProductLimit(maximumProducts);
    let evaluatedProducts = 0;
    let raisedAlerts = 0;

    for (let index = 0; index < limit; index += 1) {
      const outcome = await this.database.$transaction(
        (transaction) => this.evaluateNextProduct(transaction),
        { maxWait: 5_000, timeout: 15_000 },
      );
      if (outcome.kind === 'SKIPPED') {
        return { evaluatedProducts, passCompleted: false, raisedAlerts };
      }
      if (outcome.kind === 'PASS_COMPLETED') {
        return { evaluatedProducts, passCompleted: true, raisedAlerts };
      }
      evaluatedProducts += 1;
      if (outcome.raisedAlert) raisedAlerts += 1;
    }

    return { evaluatedProducts, passCompleted: false, raisedAlerts };
  }

  private async evaluateNextProduct(
    transaction: DatabaseTransactionClient,
  ): Promise<EvaluationOutcome> {
    const sweep = await this.lockSweepState(transaction);
    if (sweep === null) return { kind: 'SKIPPED' };

    const nextProductId = await this.findNextProduct(
      transaction,
      sweep.afterProductId,
    );
    if (nextProductId === null) {
      await transaction.stockMonitoringSweepState.update({
        where: { id: 1 },
        data: { afterProductId: null },
      });
      return { kind: 'PASS_COMPLETED' };
    }

    const now = new Date();
    const metrics = await this.readProductMetrics(
      transaction,
      nextProductId,
      now,
    );
    await transaction.$executeRaw`
      INSERT INTO "StockMonitoringState" ("productId", "updatedAt")
      VALUES (${metrics.productId}, ${now})
      ON CONFLICT ("productId") DO NOTHING
    `;
    const stateRows = await transaction.$queryRaw<
      Array<{
        depletionCycle: number;
        emptyAlertedCycle: number | null;
        lowAlertedCycle: number | null;
        state: StockLevel;
      }>
    >`
      SELECT
        "depletionCycle",
        "emptyAlertedCycle",
        "lowAlertedCycle",
        "state"::text AS "state"
      FROM "StockMonitoringState"
      WHERE "productId" = ${metrics.productId}
      FOR UPDATE
    `;
    const state = stateRows[0];
    if (state === undefined) {
      throw new Error('Stock monitoring state was not created.');
    }

    const availableStock = safeMetricCount(
      metrics.availableStock,
      'available stock',
    );
    const paidWaitingQuantity = safeMetricCount(
      metrics.paidWaitingQuantity,
      'paid waiting quantity',
    );
    const soldToday = safeMetricCount(metrics.soldToday, 'sold today');
    const transition = transitionStockMonitoringState(
      state,
      stockLevelFor(availableStock, metrics.lowStockThreshold),
    );
    await transaction.stockMonitoringState.update({
      where: { productId: metrics.productId },
      data: {
        depletionCycle: transition.depletionCycle,
        emptyAlertedCycle: transition.emptyAlertedCycle,
        lowAlertedCycle: transition.lowAlertedCycle,
        state: transition.state,
      },
    });

    if (transition.eventType !== null) {
      const alert = await transaction.stockAlert.create({
        data: {
          availableStock: metrics.availableStock,
          depletionCycle: transition.depletionCycle,
          oldestWaitingPaidAt: metrics.oldestWaitingPaidAt,
          paidWaitingQuantity: metrics.paidWaitingQuantity,
          productId: metrics.productId,
          soldToday: metrics.soldToday,
          state: transition.state,
        },
        select: { id: true },
      });
      const event = stockAlertOutboxEvent({
        alertId: alert.id,
        availableStock,
        depletionCycle: transition.depletionCycle,
        eventType: transition.eventType,
        lowStockThreshold: metrics.lowStockThreshold,
        oldestWaitingPaidAt: metrics.oldestWaitingPaidAt,
        paidWaitingQuantity,
        productId: metrics.productId,
        productPublicId: metrics.productPublicId,
        soldToday,
        state: transition.state,
      });
      assertValidOutboxEvent(event);
      await transaction.outboxEvent.create({
        data: {
          aggregateId: alert.id,
          aggregateType: event.aggregateType,
          dedupeKey: event.dedupeKey,
          eventType: event.eventType,
          payload: event.payload,
        },
      });
    }

    await transaction.stockMonitoringSweepState.update({
      where: { id: 1 },
      data: { afterProductId: metrics.productId },
    });
    return { kind: 'EVALUATED', raisedAlert: transition.eventType !== null };
  }

  private async lockSweepState(
    transaction: DatabaseTransactionClient,
  ): Promise<{ readonly afterProductId: bigint | null } | null> {
    const now = new Date();
    await transaction.$executeRaw`
      INSERT INTO "StockMonitoringSweepState" (id, "updatedAt")
      VALUES (1, ${now})
      ON CONFLICT (id) DO NOTHING
    `;
    const rows = await transaction.$queryRaw<
      Array<{ afterProductId: bigint | null }>
    >`
      SELECT "afterProductId"
      FROM "StockMonitoringSweepState"
      WHERE id = 1
      FOR UPDATE SKIP LOCKED
    `;
    return rows[0] ?? null;
  }

  private async findNextProduct(
    transaction: DatabaseTransactionClient,
    afterProductId: bigint | null,
  ): Promise<bigint | null> {
    const rows =
      afterProductId === null
        ? await transaction.$queryRaw<Array<{ id: bigint }>>`
            SELECT id
            FROM "Product"
            ORDER BY id ASC
            LIMIT 1
          `
        : await transaction.$queryRaw<Array<{ id: bigint }>>`
            SELECT id
            FROM "Product"
            WHERE id > ${afterProductId}
            ORDER BY id ASC
            LIMIT 1
          `;
    return rows[0]?.id ?? null;
  }

  private async readProductMetrics(
    transaction: DatabaseTransactionClient,
    productId: bigint,
    now: Date,
  ): Promise<ProductMetrics> {
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1_000);
    const rows = await transaction.$queryRaw<ProductMetrics[]>`
      SELECT
        product.id AS "productId",
        product."publicId"::text AS "productPublicId",
        product."lowStockThreshold",
        (
          SELECT COUNT(*)
          FROM "Voucher" AS voucher
          INNER JOIN "VoucherBatch" AS voucher_batch
            ON voucher_batch.id = voucher."batchId"
            AND voucher_batch."productId" = voucher."productId"
          WHERE voucher."productId" = product.id
            AND voucher.status = 'AVAILABLE'::"VoucherStatus"
            AND voucher_batch."importState" = 'IMPORTED'::"VoucherBatchImportState"
            AND voucher_batch."activatedAt" IS NOT NULL
            AND (
              voucher_batch."validUntil" IS NULL
              OR voucher_batch."validUntil" > ${now}
            )
        ) AS "availableStock",
        (
          SELECT COUNT(*)
          FROM "FulfilmentUnit" AS fulfilment_unit
          WHERE fulfilment_unit."productId" = product.id
            AND fulfilment_unit."allocatedAt" IS NULL
        ) AS "paidWaitingQuantity",
        (
          SELECT MIN(fulfilment_unit."paidAt")
          FROM "FulfilmentUnit" AS fulfilment_unit
          WHERE fulfilment_unit."productId" = product.id
            AND fulfilment_unit."allocatedAt" IS NULL
        ) AS "oldestWaitingPaidAt",
        (
          SELECT COUNT(*)
          FROM "Voucher" AS voucher
          WHERE voucher."productId" = product.id
            AND voucher.status = 'SOLD'::"VoucherStatus"
            AND voucher."soldAt" >= ${dayStart}
            AND voucher."soldAt" < ${dayEnd}
        ) AS "soldToday"
      FROM "Product" AS product
      WHERE product.id = ${productId}
    `;
    const metrics = rows[0];
    if (metrics === undefined) {
      throw new Error('Stock-monitoring product no longer exists.');
    }
    return metrics;
  }
}

function stockAlertOutboxEvent(input: {
  readonly alertId: bigint;
  readonly availableStock: number;
  readonly depletionCycle: number;
  readonly eventType: StockAlertEventType;
  readonly lowStockThreshold: number;
  readonly oldestWaitingPaidAt: Date | null;
  readonly paidWaitingQuantity: number;
  readonly productId: bigint;
  readonly productPublicId: string;
  readonly soldToday: number;
  readonly state: StockLevel;
}) {
  return {
    aggregateId: input.alertId.toString(),
    aggregateType: 'StockAlert',
    dedupeKey: `stock-alert:${input.productId.toString()}:${input.depletionCycle}:${input.state}`,
    eventType: input.eventType,
    payload: {
      availableStock: input.availableStock,
      depletionCycle: input.depletionCycle,
      lowStockThreshold: input.lowStockThreshold,
      oldestWaitingPaidAt: input.oldestWaitingPaidAt?.toISOString() ?? null,
      paidWaitingQuantity: input.paidWaitingQuantity,
      productPublicId: input.productPublicId,
      soldToday: input.soldToday,
      stockLevel: input.state,
      version: 1,
    },
  } as const;
}

function boundedProductLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error('maximumProducts must be an integer between 1 and 1000.');
  }
  return value;
}

function safeMetricCount(value: bigint, label: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return count;
}
