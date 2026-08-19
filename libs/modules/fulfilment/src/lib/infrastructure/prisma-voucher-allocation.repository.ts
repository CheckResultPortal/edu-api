import type { DatabaseTransactionClient } from '@edu-api/database';
import { assertValidOutboxEvent } from '@edu-api/outbox';
import type { TransactionalVoucherClaimer } from '@edu-api/voucher-inventory';

import { AllocationProcessingUnavailableError } from '../application/voucher-allocation-errors';
import type {
  SingleAllocationResult,
  VoucherAllocationRepository,
} from '../application/voucher-allocation-service';

export class PrismaVoucherAllocationRepository
  implements VoucherAllocationRepository
{
  constructor(private readonly voucherClaimer: TransactionalVoucherClaimer) {}

  async allocateNextWaitingUnitForProduct(
    transaction: DatabaseTransactionClient,
    productId: bigint,
  ): Promise<SingleAllocationResult> {
    // Claim the oldest unlocked waiting unit for this product. The caller owns
    // the transaction so allocation and PaymentSucceeded completion are atomic.
    const waitingUnits = await transaction.$queryRaw<
      Array<{
        id: bigint;
        publicReference: string;
        productId: bigint;
        orderPublicReference: string;
        productPublicId: string;
      }>
    >`
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
      LIMIT 1
      FOR UPDATE OF fulfilment_unit SKIP LOCKED
    `;

    const waitingUnit = waitingUnits[0];
    if (!waitingUnit) {
      return {
        outcome: 'NO_WAITING',
        productId,
      };
    }

    const allocatedAt = new Date();

    const claimedVoucher =
      await this.voucherClaimer.claimEligibleVoucherForProduct(transaction, {
        productId: waitingUnit.productId,
        soldAt: allocatedAt,
      });

    if (!claimedVoucher) {
      return {
        outcome: 'ZERO_STOCK',
        fulfilmentUnitPublicReference: waitingUnit.publicReference,
        productId: waitingUnit.productId,
      };
    }

    const allocations = await transaction.$queryRaw<
      Array<{
        id: bigint;
        publicReference: string;
      }>
    >`
      INSERT INTO "VoucherAllocation" (
        "publicReference",
        "fulfilmentUnitId",
        "voucherId",
        "productId",
        "allocatedAt"
      )
      VALUES (
        gen_random_uuid(),
        ${waitingUnit.id},
        ${claimedVoucher.voucherId},
        ${waitingUnit.productId},
        ${allocatedAt}
      )
      RETURNING id, "publicReference"::text AS "publicReference"
    `;
    const allocation = allocations[0];
    if (!allocation) {
      throw new AllocationProcessingUnavailableError(
        'Failed to create allocation record.',
      );
    }

    const updatedUnitCount = await transaction.$executeRaw`
      UPDATE "FulfilmentUnit"
      SET "allocatedAt" = ${allocatedAt}
      WHERE id = ${waitingUnit.id} AND "allocatedAt" IS NULL
    `;
    if (updatedUnitCount !== 1) {
      throw new AllocationProcessingUnavailableError(
        'Failed to finalize the claimed fulfilment unit.',
      );
    }

    const payload = {
      version: 1,
      allocationPublicReference: allocation.publicReference,
      fulfilmentUnitPublicReference: waitingUnit.publicReference,
      orderPublicReference: waitingUnit.orderPublicReference,
      productPublicId: waitingUnit.productPublicId,
      allocatedAt: allocatedAt.toISOString(),
    } as const;

    assertValidOutboxEvent({
      aggregateId: waitingUnit.id.toString(),
      aggregateType: 'FulfilmentUnit',
      eventType: 'VoucherAllocated',
      dedupeKey: `voucher-allocated:${waitingUnit.publicReference}`,
      payload,
    });

    await transaction.outboxEvent.create({
      data: {
        aggregateId: waitingUnit.id,
        aggregateType: 'FulfilmentUnit',
        eventType: 'VoucherAllocated',
        dedupeKey: `voucher-allocated:${waitingUnit.publicReference}`,
        payload,
      },
    });

    return {
      outcome: 'ALLOCATED',
      allocationPublicReference: allocation.publicReference,
      fulfilmentUnitPublicReference: waitingUnit.publicReference,
      productId: waitingUnit.productId,
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
}
