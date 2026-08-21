import type { DatabaseTransactionClient } from '@edu-api/database';

import type {
  AllocationCycleResult,
  VoucherAllocationService,
} from '../application/voucher-allocation-service';

export interface VoucherStockAddedPayload {
  readonly batchPublicId: string;
  readonly productPublicId: string;
  readonly quantity: number;
  readonly version: 1;
}

export class VoucherStockAddedAllocationHandler {
  constructor(private readonly allocationService: VoucherAllocationService) {}

  handle(
    transaction: DatabaseTransactionClient,
    payload: VoucherStockAddedPayload,
    maximumUnits: number,
  ): Promise<AllocationCycleResult> {
    return this.allocationService.allocateWaitingUnitsForProductPublicId(
      transaction,
      payload.productPublicId,
      maximumUnits,
    );
  }
}
