export const USSD_SESSION_STORE = Symbol('USSD_SESSION_STORE');

export type UssdFlowState =
  | 'PRODUCT'
  | 'QUANTITY'
  | 'DELIVERY'
  | 'EMAIL'
  | 'FIRST_NAME'
  | 'CONFIRM'
  | 'PAYMENT_PENDING';

/**
 * Transient, Redis-only session state. It never holds payment truth:
 * orders and payments live in PostgreSQL through the core services.
 */
export interface UssdSessionData {
  readonly state: UssdFlowState;
  /** True once the product menu has been rendered for this session. */
  readonly productMenuShown?: boolean;
  readonly productPublicId?: string;
  readonly productName?: string;
  readonly unitPriceMinor?: string;
  readonly quantity?: number;
  readonly deliveryPreference?: 'SMS_ONLY' | 'EMAIL_ONLY' | 'SMS_AND_EMAIL';
  readonly email?: string;
  readonly firstName?: string;
  /** Set when the confirm step starts so retries reuse the same references. */
  readonly confirmId?: string;
  /** Retained without contact data while a payment start is being recovered. */
  readonly paymentOrderPublicReference?: string;
}

export interface UssdSessionStore {
  get(msisdn: string): Promise<UssdSessionData | null>;
  set(
    msisdn: string,
    data: UssdSessionData,
    ttlMilliseconds: number,
  ): Promise<void>;
  delete(msisdn: string): Promise<void>;
}
