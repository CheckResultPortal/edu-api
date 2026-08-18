import type { DatabaseTransactionClient } from '@edu-api/database';

import type {
  PaidOrderSnapshot,
  PaymentOrderQuery,
  WebPaymentOrderSnapshot,
} from '../application/payment-order-query';

export class PrismaPaymentOrderQuery implements PaymentOrderQuery {
  async getWebPaymentOrder(
    transaction: DatabaseTransactionClient,
    publicReference: string,
  ): Promise<WebPaymentOrderSnapshot | null> {
    const order = await transaction.order.findFirst({
      where: {
        publicReference,
        purchaseChannel: 'WEB',
        contactAnonymizedAt: null,
        email: { not: null },
      },
      select: {
        currency: true,
        email: true,
        id: true,
        publicReference: true,
        totalPriceMinor: true,
      },
    });
    if (order === null || order.email === null) return null;

    return { ...order, email: order.email };
  }

  async getWebPaymentOrderById(
    transaction: DatabaseTransactionClient,
    orderId: bigint,
  ): Promise<WebPaymentOrderSnapshot | null> {
    const order = await transaction.order.findFirst({
      where: {
        id: orderId,
        purchaseChannel: 'WEB',
        contactAnonymizedAt: null,
        email: { not: null },
      },
      select: {
        currency: true,
        email: true,
        id: true,
        publicReference: true,
        totalPriceMinor: true,
      },
    });
    if (order === null || order.email === null) return null;

    return { ...order, email: order.email };
  }

  async getPaidOrder(
    transaction: DatabaseTransactionClient,
    orderId: bigint,
  ): Promise<PaidOrderSnapshot | null> {
    const order = await transaction.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        publicReference: true,
        items: {
          take: 2,
          select: { id: true, productId: true, quantity: true },
        },
      },
    });
    if (order === null || order.items.length !== 1) return null;

    return {
      id: order.id,
      item: order.items[0],
      publicReference: order.publicReference,
    };
  }
}
