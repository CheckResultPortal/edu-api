import type { DatabaseTransactionClient } from '@edu-api/database';

import type {
  CreatePaidFulfilmentUnitsInput,
  TransactionalFulfilmentUnitWriter,
} from '../application/transactional-fulfilment-unit-writer';

export class PrismaTransactionalFulfilmentUnitWriter
  implements TransactionalFulfilmentUnitWriter
{
  async createPaidUnits(
    transaction: DatabaseTransactionClient,
    input: CreatePaidFulfilmentUnitsInput,
  ): Promise<void> {
    if (
      !Number.isInteger(input.quantity) ||
      input.quantity < 1 ||
      input.quantity > 20
    ) {
      throw new Error('Paid order quantity must be between 1 and 20.');
    }

    await transaction.fulfilmentUnit.createMany({
      data: Array.from({ length: input.quantity }, (_, index) => ({
        orderItemId: input.orderItemId,
        paidAt: input.paidAt,
        paymentApplicationId: input.paymentApplicationId,
        productId: input.productId,
        ordinal: index + 1,
      })),
    });
  }
}
