import type { DatabaseTransactionClient } from '@edu-api/database';

export const TRANSACTIONAL_FULFILMENT_UNIT_WRITER = Symbol(
  'TRANSACTIONAL_FULFILMENT_UNIT_WRITER',
);

export interface CreatePaidFulfilmentUnitsInput {
  readonly orderItemId: bigint;
  readonly orderPublicReference: string;
  readonly paidAt: Date;
  readonly paymentApplicationId: bigint;
  readonly productId: bigint;
  readonly productPublicId: string;
  readonly quantity: number;
}

export interface TransactionalFulfilmentUnitWriter {
  createPaidUnits(
    transaction: DatabaseTransactionClient,
    input: CreatePaidFulfilmentUnitsInput,
  ): Promise<void>;
}
