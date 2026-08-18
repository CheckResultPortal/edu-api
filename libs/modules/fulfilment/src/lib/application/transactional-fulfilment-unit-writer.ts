import type { DatabaseTransactionClient } from '@edu-api/database';

export const TRANSACTIONAL_FULFILMENT_UNIT_WRITER = Symbol(
  'TRANSACTIONAL_FULFILMENT_UNIT_WRITER',
);

export interface CreatePaidFulfilmentUnitsInput {
  readonly orderItemId: bigint;
  readonly paidAt: Date;
  readonly paymentApplicationId: bigint;
  readonly productId: bigint;
  readonly quantity: number;
}

export interface TransactionalFulfilmentUnitWriter {
  createPaidUnits(
    transaction: DatabaseTransactionClient,
    input: CreatePaidFulfilmentUnitsInput,
  ): Promise<void>;
}
