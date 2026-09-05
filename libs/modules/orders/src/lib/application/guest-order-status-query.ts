export const GUEST_ORDER_STATUS_QUERY = Symbol('GUEST_ORDER_STATUS_QUERY');
export const GUEST_ORDER_STATUS_RATE_LIMITER = Symbol(
  'GUEST_ORDER_STATUS_RATE_LIMITER',
);

export type GuestOrderLifecycleStatus =
  | 'PAYMENT_PENDING'
  | 'PAYMENT_FAILED'
  | 'WAITING_FOR_STOCK'
  | 'DELIVERY_IN_PROGRESS'
  | 'DELIVERY_ISSUE'
  | 'DELIVERED';

export interface GuestOrderSummary {
  readonly customerCode?: string | null;
  readonly canRequestVoucherEmail: boolean;
  readonly publicReference: string;
  readonly productName: string;
  readonly quantity: number;
  readonly totalPriceMinor: string;
  readonly currency: string;
  readonly status: GuestOrderLifecycleStatus;
  readonly createdAt: Date;
}

export interface GuestOrderRetrievalAccess {
  readonly destinationEmail: string;
  readonly orderId: bigint;
}

export interface GuestOrderStatusQuery {
  findByPhoneAndEmail(
    phoneNumber: string,
    email: string,
  ): Promise<readonly GuestOrderSummary[]>;

  findByPhoneAndReference(
    phoneNumber: string,
    orderReference: string,
  ): Promise<GuestOrderSummary | null>;

  findVoucherRetrievalAccess(input: {
    readonly email?: string;
    readonly orderReference: string;
    readonly phoneNumber?: string;
  }): Promise<GuestOrderRetrievalAccess | null>;
}
