import type { DatabaseTransactionClient } from '@edu-api/database';

export const PAYMENT_ORDER_QUERY = Symbol('PAYMENT_ORDER_QUERY');

export interface WebPaymentOrderSnapshot {
  readonly currency: string;
  readonly email: string;
  readonly id: bigint;
  readonly publicReference: string;
  readonly totalPriceMinor: bigint;
}

export interface PaidOrderItemSnapshot {
  readonly id: bigint;
  readonly productId: bigint;
  readonly productPublicId: string;
  readonly quantity: number;
}

export interface PaidOrderSnapshot {
  readonly id: bigint;
  readonly item: PaidOrderItemSnapshot;
  readonly publicReference: string;
}

/**
 * Orders-owned transactional read facade for payment initialization and the
 * atomic payment-to-fulfilment transition.
 */
export interface PaymentOrderQuery {
  getPaidOrder(
    transaction: DatabaseTransactionClient,
    orderId: bigint,
  ): Promise<PaidOrderSnapshot | null>;

  getWebPaymentOrder(
    transaction: DatabaseTransactionClient,
    publicReference: string,
  ): Promise<WebPaymentOrderSnapshot | null>;

  getWebPaymentOrderById(
    transaction: DatabaseTransactionClient,
    orderId: bigint,
  ): Promise<WebPaymentOrderSnapshot | null>;
}
