import type { DatabaseTransactionClient } from '@edu-api/database';

export const VOUCHER_ALLOCATION_REPOSITORY = Symbol(
  'VOUCHER_ALLOCATION_REPOSITORY',
);
export const VOUCHER_ALLOCATION_SERVICE = Symbol('VOUCHER_ALLOCATION_SERVICE');

export type SingleAllocationResult =
  | {
      readonly allocationPublicReference: string;
      readonly fulfilmentUnitPublicReference: string;
      readonly outcome: 'ALLOCATED';
      readonly productId: bigint;
    }
  | {
      readonly fulfilmentUnitPublicReference: string;
      readonly outcome: 'ZERO_STOCK';
      readonly productId: bigint;
    }
  | {
      readonly outcome: 'NO_WAITING';
      readonly productId: bigint;
    };

export interface AllocationCycleResult {
  readonly allocatedCount: number;
  readonly examinedCount: number;
  readonly stoppedForZeroStock: boolean;
}

export interface VoucherAllocationRepository {
  allocateNextWaitingUnitForProduct(
    transaction: DatabaseTransactionClient,
    productId: bigint,
  ): Promise<SingleAllocationResult>;

  findProductIdByOrderPublicReference(
    transaction: DatabaseTransactionClient,
    orderPublicReference: string,
  ): Promise<bigint | null>;
}

export interface VoucherAllocationService {
  allocateUnitsForOrder(
    transaction: DatabaseTransactionClient,
    orderPublicReference: string,
    maximumUnits: number,
  ): Promise<AllocationCycleResult>;

  allocateWaitingUnitsForProduct(
    transaction: DatabaseTransactionClient,
    productId: bigint,
    maximumUnits?: number,
  ): Promise<AllocationCycleResult>;
}

export class DefaultVoucherAllocationService
  implements VoucherAllocationService
{
  constructor(private readonly repository: VoucherAllocationRepository) {}

  async allocateUnitsForOrder(
    transaction: DatabaseTransactionClient,
    orderPublicReference: string,
    maximumUnits: number,
  ): Promise<AllocationCycleResult> {
    const productId = await this.repository.findProductIdByOrderPublicReference(
      transaction,
      orderPublicReference,
    );
    if (productId === null) {
      throw new Error(
        'PaymentSucceeded does not reference a paid fulfilment obligation.',
      );
    }
    return this.allocateWaitingUnitsForProduct(
      transaction,
      productId,
      maximumUnits,
    );
  }

  async allocateWaitingUnitsForProduct(
    transaction: DatabaseTransactionClient,
    productId: bigint,
    maximumUnits = 50,
  ): Promise<AllocationCycleResult> {
    if (!Number.isInteger(maximumUnits) || maximumUnits < 1) {
      throw new Error('maximumUnits must be a positive integer.');
    }
    const boundedMaximumUnits = Math.min(maximumUnits, 500);
    let examinedCount = 0;
    let allocatedCount = 0;
    let stoppedForZeroStock = false;

    for (let index = 0; index < boundedMaximumUnits; index += 1) {
      const result = await this.repository.allocateNextWaitingUnitForProduct(
        transaction,
        productId,
      );
      if (result.outcome === 'NO_WAITING') break;

      examinedCount += 1;
      if (result.outcome === 'ALLOCATED') {
        allocatedCount += 1;
      } else {
        stoppedForZeroStock = true;
        break;
      }
    }

    return {
      allocatedCount,
      examinedCount,
      stoppedForZeroStock,
    };
  }
}
