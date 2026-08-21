import { randomUUID } from 'node:crypto';

import { Prisma } from '../../../../../../generated/prisma/client';

import type { DatabaseTransactionClient } from '@edu-api/database';
import { assertValidOutboxEvent } from '@edu-api/outbox';
import type { TransactionalVoucherClaimer } from '@edu-api/voucher-inventory';

import { AllocationProcessingUnavailableError } from '../application/voucher-allocation-errors';
import type {
  AllocationCycleResult,
  RestockSweepResult,
  SingleAllocationResult,
  VoucherAllocationRepository,
} from '../application/voucher-allocation-service';

interface WaitingUnit {
  readonly id: bigint;
  readonly orderPublicReference: string;
  readonly productId: bigint;
  readonly productPublicId: string;
  readonly publicReference: string;
}

interface AllocationPair {
  readonly allocationPublicReference: string;
  readonly fulfilmentUnit: WaitingUnit;
  readonly voucherId: bigint;
}

interface AllocationBatch {
  readonly allocations: readonly AllocationPair[];
  readonly waitingUnits: readonly WaitingUnit[];
}

export class PrismaVoucherAllocationRepository
  implements VoucherAllocationRepository
{
  constructor(private readonly voucherClaimer: TransactionalVoucherClaimer) {}

  async allocateNextWaitingUnitForProduct(
    transaction: DatabaseTransactionClient,
    productId: bigint,
  ): Promise<SingleAllocationResult> {
    const batch = await this.allocateWaitingUnitBatch(
      transaction,
      productId,
      1,
    );
    const waitingUnit = batch.waitingUnits[0];
    if (waitingUnit === undefined) return { outcome: 'NO_WAITING', productId };

    const allocation = batch.allocations[0];
    if (allocation === undefined) {
      return {
        outcome: 'ZERO_STOCK',
        fulfilmentUnitPublicReference: waitingUnit.publicReference,
        productId,
      };
    }

    return {
      outcome: 'ALLOCATED',
      allocationPublicReference: allocation.allocationPublicReference,
      fulfilmentUnitPublicReference: waitingUnit.publicReference,
      productId,
    };
  }

  async allocateWaitingUnitsForProduct(
    transaction: DatabaseTransactionClient,
    productId: bigint,
    maximumUnits: number,
  ): Promise<AllocationCycleResult> {
    const batch = await this.allocateWaitingUnitBatch(
      transaction,
      productId,
      maximumUnits,
    );
    const waitingCount = batch.waitingUnits.length;
    const allocatedCount = batch.allocations.length;
    if (waitingCount === 0) {
      return {
        allocatedCount: 0,
        examinedCount: 0,
        stoppedForZeroStock: false,
      };
    }

    return {
      allocatedCount,
      examinedCount:
        allocatedCount === waitingCount ? allocatedCount : allocatedCount + 1,
      stoppedForZeroStock: allocatedCount < waitingCount,
    };
  }

  async drainNextWaitingProduct(
    transaction: DatabaseTransactionClient,
    maximumUnits: number,
  ): Promise<RestockSweepResult> {
    const state = await this.lockSweepState(transaction);
    if (state === null) return { outcome: 'NO_WAITING' };

    const waitingProduct = await this.findNextWaitingProduct(
      transaction,
      state.afterProductId,
    );
    if (waitingProduct === null) {
      if (state.afterProductId !== null) {
        await transaction.$executeRaw`
          UPDATE "FulfilmentBacklogSweepState"
          SET "afterProductId" = NULL, "updatedAt" = ${new Date()}
          WHERE id = 1
        `;
        return { outcome: 'CURSOR_RESET' };
      }
      return { outcome: 'NO_WAITING' };
    }

    const allocation = await this.allocateWaitingUnitsForProduct(
      transaction,
      waitingProduct.productId,
      maximumUnits,
    );
    await transaction.$executeRaw`
      UPDATE "FulfilmentBacklogSweepState"
      SET "afterProductId" = ${waitingProduct.productId},
          "updatedAt" = ${new Date()}
      WHERE id = 1
    `;

    return {
      allocation,
      outcome: 'DRAINED',
      productPublicId: waitingProduct.productPublicId,
    };
  }

  async findProductIdByOrderPublicReference(
    transaction: DatabaseTransactionClient,
    orderPublicReference: string,
  ): Promise<bigint | null> {
    const productRows = await transaction.$queryRaw<
      Array<{ productId: bigint }>
    >`
      SELECT fulfilment_unit."productId"
      FROM "FulfilmentUnit" AS fulfilment_unit
      WHERE fulfilment_unit."orderPublicReference" = ${orderPublicReference}::uuid
      ORDER BY fulfilment_unit.id ASC
      LIMIT 1
    `;
    return productRows[0]?.productId ?? null;
  }

  async findProductIdByProductPublicId(
    transaction: DatabaseTransactionClient,
    productPublicId: string,
  ): Promise<bigint | null> {
    const productRows = await transaction.$queryRaw<
      Array<{ productId: bigint }>
    >`
      SELECT fulfilment_unit."productId"
      FROM "FulfilmentUnit" AS fulfilment_unit
      WHERE fulfilment_unit."productPublicId" = ${productPublicId}::uuid
        AND fulfilment_unit."allocatedAt" IS NULL
      ORDER BY fulfilment_unit."paidAt" ASC, fulfilment_unit.id ASC
      LIMIT 1
    `;
    return productRows[0]?.productId ?? null;
  }

  private async allocateWaitingUnitBatch(
    transaction: DatabaseTransactionClient,
    productId: bigint,
    maximumUnits: number,
  ): Promise<AllocationBatch> {
    const waitingUnits = await transaction.$queryRaw<WaitingUnit[]>`
      SELECT
        fulfilment_unit.id,
        fulfilment_unit."publicReference"::text AS "publicReference",
        fulfilment_unit."productId",
        fulfilment_unit."orderPublicReference"::text AS "orderPublicReference",
        fulfilment_unit."productPublicId"::text AS "productPublicId"
      FROM "FulfilmentUnit" AS fulfilment_unit
      WHERE fulfilment_unit."productId" = ${productId}
        AND fulfilment_unit."allocatedAt" IS NULL
      ORDER BY fulfilment_unit."paidAt" ASC, fulfilment_unit.id ASC
      LIMIT ${maximumUnits}
      FOR UPDATE OF fulfilment_unit SKIP LOCKED
    `;
    if (waitingUnits.length === 0) {
      return { allocations: [], waitingUnits };
    }

    const allocatedAt = new Date();
    const claimedVouchers =
      await this.voucherClaimer.claimEligibleVouchersForProduct(transaction, {
        maximumVouchers: waitingUnits.length,
        productId,
        soldAt: allocatedAt,
      });
    const allocationPairs = waitingUnits
      .slice(0, claimedVouchers.length)
      .map((fulfilmentUnit, index) => ({
        allocationPublicReference: randomUUID(),
        fulfilmentUnit,
        voucherId: claimedVouchers[index].voucherId,
      }));
    if (allocationPairs.length === 0) {
      return { allocations: [], waitingUnits };
    }

    await transaction.voucherAllocation.createMany({
      data: allocationPairs.map((pair) => ({
        allocatedAt,
        fulfilmentUnitId: pair.fulfilmentUnit.id,
        productId,
        publicReference: pair.allocationPublicReference,
        voucherId: pair.voucherId,
      })),
    });
    const updatedUnits = await transaction.fulfilmentUnit.updateMany({
      where: {
        allocatedAt: null,
        id: { in: allocationPairs.map((pair) => pair.fulfilmentUnit.id) },
        productId,
      },
      data: { allocatedAt },
    });
    if (updatedUnits.count !== allocationPairs.length) {
      throw new AllocationProcessingUnavailableError(
        'Failed to finalize all claimed fulfilment units.',
      );
    }

    const outboxRows = allocationPairs.map((pair) => {
      const payload = {
        allocationPublicReference: pair.allocationPublicReference,
        allocatedAt: allocatedAt.toISOString(),
        fulfilmentUnitPublicReference: pair.fulfilmentUnit.publicReference,
        orderPublicReference: pair.fulfilmentUnit.orderPublicReference,
        productPublicId: pair.fulfilmentUnit.productPublicId,
        version: 1,
      } as const;
      assertValidOutboxEvent({
        aggregateId: pair.fulfilmentUnit.id.toString(),
        aggregateType: 'FulfilmentUnit',
        dedupeKey: `voucher-allocated:${pair.fulfilmentUnit.publicReference}`,
        eventType: 'VoucherAllocated',
        payload,
      });
      return {
        aggregateId: pair.fulfilmentUnit.id,
        aggregateType: 'FulfilmentUnit',
        dedupeKey: `voucher-allocated:${pair.fulfilmentUnit.publicReference}`,
        eventType: 'VoucherAllocated',
        payload: payload as unknown as Prisma.InputJsonValue,
      };
    });
    await transaction.outboxEvent.createMany({ data: outboxRows });

    return { allocations: allocationPairs, waitingUnits };
  }

  private async lockSweepState(
    transaction: DatabaseTransactionClient,
  ): Promise<{ readonly afterProductId: bigint | null } | null> {
    await transaction.$executeRaw`
      INSERT INTO "FulfilmentBacklogSweepState" (id, "updatedAt")
      VALUES (1, ${new Date()})
      ON CONFLICT (id) DO NOTHING
    `;
    const states = await transaction.$queryRaw<
      Array<{ afterProductId: bigint | null }>
    >`
      SELECT "afterProductId"
      FROM "FulfilmentBacklogSweepState"
      WHERE id = 1
      FOR UPDATE SKIP LOCKED
    `;
    return states[0] ?? null;
  }

  private async findNextWaitingProduct(
    transaction: DatabaseTransactionClient,
    afterProductId: bigint | null,
  ): Promise<{
    readonly productId: bigint;
    readonly productPublicId: string;
  } | null> {
    const rows =
      afterProductId === null
        ? await transaction.$queryRaw<
            Array<{ productId: bigint; productPublicId: string }>
          >`
            SELECT
              fulfilment_unit."productId",
              fulfilment_unit."productPublicId"::text AS "productPublicId"
            FROM "FulfilmentUnit" AS fulfilment_unit
            WHERE fulfilment_unit."allocatedAt" IS NULL
            ORDER BY
              fulfilment_unit."productId" ASC,
              fulfilment_unit."paidAt" ASC,
              fulfilment_unit.id ASC
            LIMIT 1
          `
        : await transaction.$queryRaw<
            Array<{ productId: bigint; productPublicId: string }>
          >`
            SELECT
              fulfilment_unit."productId",
              fulfilment_unit."productPublicId"::text AS "productPublicId"
            FROM "FulfilmentUnit" AS fulfilment_unit
            WHERE fulfilment_unit."allocatedAt" IS NULL
              AND fulfilment_unit."productId" > ${afterProductId}
            ORDER BY
              fulfilment_unit."productId" ASC,
              fulfilment_unit."paidAt" ASC,
              fulfilment_unit.id ASC
            LIMIT 1
          `;
    return rows[0] ?? null;
  }
}
