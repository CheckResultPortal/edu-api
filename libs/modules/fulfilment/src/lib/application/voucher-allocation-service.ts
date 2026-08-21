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

export type RestockSweepResult =
  | {
      readonly allocation: AllocationCycleResult;
      readonly outcome: 'DRAINED';
      readonly productPublicId: string;
    }
  | { readonly outcome: 'CURSOR_RESET' | 'NO_WAITING' };

export interface VoucherAllocationRepository {
  allocateNextWaitingUnitForProduct(
    transaction: DatabaseTransactionClient,
    productId: bigint,
  ): Promise<SingleAllocationResult>;

  allocateWaitingUnitsForProduct(
    transaction: DatabaseTransactionClient,
    productId: bigint,
    maximumUnits: number,
  ): Promise<AllocationCycleResult>;

  drainNextWaitingProduct(
    transaction: DatabaseTransactionClient,
    maximumUnits: number,
  ): Promise<RestockSweepResult>;

  findProductIdByOrderPublicReference(
    transaction: DatabaseTransactionClient,
    orderPublicReference: string,
  ): Promise<bigint | null>;

  findProductIdByProductPublicId(
    transaction: DatabaseTransactionClient,
    productPublicId: string,
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

  allocateWaitingUnitsForProductPublicId(
    transaction: DatabaseTransactionClient,
    productPublicId: string,
    maximumUnits?: number,
  ): Promise<AllocationCycleResult>;

  drainNextWaitingProduct(
    transaction: DatabaseTransactionClient,
    maximumUnits?: number,
  ): Promise<RestockSweepResult>;
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
    return this.repository.allocateWaitingUnitsForProduct(
      transaction,
      productId,
      normalizeMaximumUnits(maximumUnits),
    );
  }

  async allocateWaitingUnitsForProductPublicId(
    transaction: DatabaseTransactionClient,
    productPublicId: string,
    maximumUnits = 50,
  ): Promise<AllocationCycleResult> {
    const productId = await this.repository.findProductIdByProductPublicId(
      transaction,
      productPublicId,
    );
    if (productId === null) return noAllocationWork();
    return this.allocateWaitingUnitsForProduct(
      transaction,
      productId,
      maximumUnits,
    );
  }

  drainNextWaitingProduct(
    transaction: DatabaseTransactionClient,
    maximumUnits = 50,
  ): Promise<RestockSweepResult> {
    return this.repository.drainNextWaitingProduct(
      transaction,
      normalizeMaximumUnits(maximumUnits),
    );
  }
}

function normalizeMaximumUnits(maximumUnits: number): number {
  if (!Number.isInteger(maximumUnits) || maximumUnits < 1) {
    throw new Error('maximumUnits must be a positive integer.');
  }
  return Math.min(maximumUnits, 500);
}

function noAllocationWork(): AllocationCycleResult {
  return {
    allocatedCount: 0,
    examinedCount: 0,
    stoppedForZeroStock: false,
  };
}
