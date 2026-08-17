import { createRequestFingerprint } from '@edu-api/idempotency';

import {
  assertOrderIdempotencyKey,
  type CreateGuestOrderDraft,
  validateGuestOrderInput,
} from '../domain/order-validation';

export const ORDER_CREATION_REPOSITORY = Symbol('ORDER_CREATION_REPOSITORY');
export const ORDER_CREATION_SERVICE = Symbol('ORDER_CREATION_SERVICE');
export const ORDER_RATE_LIMITER = Symbol('ORDER_RATE_LIMITER');

export interface GuestOrder {
  readonly currency: 'GHS';
  readonly productPublicId: string;
  readonly publicReference: string;
  readonly quantity: number;
  readonly totalPriceMinor: string;
  readonly unitPriceMinor: string;
}

export interface CreateGuestOrderCommand extends CreateGuestOrderDraft {
  readonly idempotencyKey: string;
}

export interface OrderCreationContext {
  readonly clientIp: string;
}

export interface PersistGuestOrderInput {
  readonly email: string | null;
  readonly idempotencyExpiresAt: Date;
  readonly idempotencyKey: string;
  readonly phoneNumber: string;
  readonly productPublicId: string;
  readonly quantity: number;
  readonly requestFingerprint: string;
}

export interface OrderCreationRepository {
  create(input: PersistGuestOrderInput): Promise<GuestOrder>;
}

export interface OrderRateLimiter {
  consume(input: {
    readonly clientIp: string;
    readonly phoneNumber: string;
  }): Promise<void>;
}

export interface OrderCreationService {
  create(
    command: CreateGuestOrderCommand,
    context: OrderCreationContext,
  ): Promise<GuestOrder>;
}

export class DefaultOrderCreationService implements OrderCreationService {
  constructor(
    private readonly repository: OrderCreationRepository,
    private readonly rateLimiter: OrderRateLimiter,
    private readonly idempotencyTtlMs: number,
  ) {}

  async create(
    command: CreateGuestOrderCommand,
    context: OrderCreationContext,
  ): Promise<GuestOrder> {
    const input = validateGuestOrderInput(command);
    const idempotencyKey = assertOrderIdempotencyKey(command.idempotencyKey);
    await this.rateLimiter.consume({
      clientIp: context.clientIp,
      phoneNumber: input.phoneNumber,
    });

    return this.repository.create({
      ...input,
      idempotencyExpiresAt: new Date(Date.now() + this.idempotencyTtlMs),
      idempotencyKey,
      requestFingerprint: createRequestFingerprint(input),
    });
  }
}
