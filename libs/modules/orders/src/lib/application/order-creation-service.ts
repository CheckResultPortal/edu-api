import { createRequestFingerprint } from '@edu-api/idempotency';

import {
  assertOrderIdempotencyKey,
  type CreateUssdGuestOrderDraft,
  type CreateWebGuestOrderDraft,
  type OrderDeliveryPreference,
  type PurchaseChannel,
  validateUssdGuestOrderInput,
  validateWebGuestOrderInput,
} from '../domain/order-validation';

export const ORDER_CREATION_REPOSITORY = Symbol('ORDER_CREATION_REPOSITORY');
export const ORDER_CREATION_SERVICE = Symbol('ORDER_CREATION_SERVICE');
export const ORDER_RATE_LIMITER = Symbol('ORDER_RATE_LIMITER');
export const ORDER_USSD_CREATION_SERVICE = Symbol(
  'ORDER_USSD_CREATION_SERVICE',
);

export interface GuestOrder {
  readonly currency: 'GHS';
  readonly deliveryPreference: OrderDeliveryPreference;
  readonly productPublicId: string;
  readonly publicReference: string;
  readonly purchaseChannel: PurchaseChannel;
  readonly quantity: number;
  readonly totalPriceMinor: string;
  readonly unitPriceMinor: string;
}

export interface CreateGuestOrderCommand extends CreateWebGuestOrderDraft {
  readonly idempotencyKey: string;
}

export interface OrderCreationContext {
  readonly clientIp: string;
}

export interface PersistGuestOrderInput {
  readonly deliveryPreference: OrderDeliveryPreference;
  readonly email: string | null;
  readonly idempotencyExpiresAt: Date;
  readonly idempotencyKey: string;
  readonly phoneNumber: string;
  readonly productPublicId: string;
  readonly purchaseChannel: PurchaseChannel;
  readonly quantity: number;
  readonly requestFingerprint: string;
}

export interface OrderCreationRepository {
  create(input: PersistGuestOrderInput): Promise<GuestOrder>;
}

export interface OrderRateLimiter {
  consume(input: {
    /** Omitted for authenticated gateway traffic; phone limits still apply. */
    readonly clientIp?: string;
    readonly phoneNumber: string;
  }): Promise<void>;
}

export interface OrderCreationService {
  create(
    command: CreateGuestOrderCommand,
    context: OrderCreationContext,
  ): Promise<GuestOrder>;
}

export interface UssdGuestOrderCommand extends CreateUssdGuestOrderDraft {
  readonly idempotencyKey: string;
}

export class DefaultUssdOrderCreationService {
  constructor(
    private readonly repository: OrderCreationRepository,
    private readonly rateLimiter: OrderRateLimiter,
    private readonly idempotencyTtlMs: number,
    private readonly privacyHmacKey: Uint8Array,
  ) {}

  async create(
    command: UssdGuestOrderCommand,
    _context: OrderCreationContext,
  ): Promise<GuestOrder> {
    const input = validateUssdGuestOrderInput(command);
    const idempotencyKey = assertOrderIdempotencyKey(command.idempotencyKey);
    await this.rateLimiter.consume({
      phoneNumber: input.phoneNumber,
    });

    return this.repository.create({
      ...input,
      idempotencyExpiresAt: new Date(Date.now() + this.idempotencyTtlMs),
      idempotencyKey,
      requestFingerprint: createRequestFingerprint(input, this.privacyHmacKey),
    });
  }
}

export class DefaultOrderCreationService implements OrderCreationService {
  constructor(
    private readonly repository: OrderCreationRepository,
    private readonly rateLimiter: OrderRateLimiter,
    private readonly idempotencyTtlMs: number,
    private readonly privacyHmacKey: Uint8Array,
  ) {}

  async create(
    command: CreateGuestOrderCommand,
    context: OrderCreationContext,
  ): Promise<GuestOrder> {
    const input = validateWebGuestOrderInput(command);
    const idempotencyKey = assertOrderIdempotencyKey(command.idempotencyKey);
    await this.rateLimiter.consume({
      clientIp: context.clientIp,
      phoneNumber: input.phoneNumber,
    });

    return this.repository.create({
      ...input,
      idempotencyExpiresAt: new Date(Date.now() + this.idempotencyTtlMs),
      idempotencyKey,
      requestFingerprint: createRequestFingerprint(input, this.privacyHmacKey),
    });
  }
}
