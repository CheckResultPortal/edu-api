import type { DatabaseTransactionClient } from '@edu-api/database';

import type {
  AllocationCycleResult,
  VoucherAllocationService,
} from '../application/voucher-allocation-service';

export interface PaymentSucceededPayload {
  readonly amountMinor: string;
  readonly currency: 'GHS';
  readonly orderPublicReference: string;
  readonly paidAt: string;
  readonly paymentPublicReference: string;
  readonly providerReference: string;
  readonly quantity: number;
  readonly version: 1;
}

export class PaymentSucceededAllocationHandler {
  constructor(private readonly allocationService: VoucherAllocationService) {}

  async handle(
    transaction: DatabaseTransactionClient,
    payload: PaymentSucceededPayload,
  ): Promise<AllocationCycleResult> {
    if (!payload.orderPublicReference) {
      throw new Error('PaymentSucceeded payload missing orderPublicReference.');
    }
    return this.allocationService.allocateUnitsForOrder(
      transaction,
      payload.orderPublicReference,
      payload.quantity,
    );
  }
}
