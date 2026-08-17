import type { Prisma } from '../../../../../../generated/prisma/client';

export const TRANSACTIONAL_ORDER_PRODUCT_QUERY = Symbol(
  'TRANSACTIONAL_ORDER_PRODUCT_QUERY',
);

export interface OrderProductSnapshot {
  readonly currency: string;
  readonly id: bigint;
  readonly publicId: string;
  readonly sellingPriceMinor: bigint;
}

/**
 * Catalog-owned read facade for consumers that must snapshot an active product
 * inside their own Prisma transaction. Prisma remains confined to
 * infrastructure code on both sides of this contract.
 */
export interface TransactionalOrderProductQuery {
  getActiveOrderProduct(
    transaction: Prisma.TransactionClient,
    publicId: string,
  ): Promise<OrderProductSnapshot | null>;
}

export class PrismaTransactionalOrderProductQuery
  implements TransactionalOrderProductQuery
{
  async getActiveOrderProduct(
    transaction: Prisma.TransactionClient,
    publicId: string,
  ): Promise<OrderProductSnapshot | null> {
    return transaction.product.findFirst({
      where: { publicId, isActive: true },
      select: {
        currency: true,
        id: true,
        publicId: true,
        sellingPriceMinor: true,
      },
    });
  }
}
