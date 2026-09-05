import type { CustomerVoucherRetrieval } from '@edu-api/communication';

import type { GuestOrderStatusQuery } from './guest-order-status-query';
import type { OrderRateLimiter } from './order-creation-service';
import {
  assertOrderIdempotencyKey,
  normalizeGhanaPhoneNumber,
  normalizeOrderPublicReference,
  parseGuestVoucherRetrievalRequest,
} from '../domain/order-validation';

export const GUEST_VOUCHER_RETRIEVAL_SERVICE = Symbol(
  'GUEST_VOUCHER_RETRIEVAL_SERVICE',
);
export class GuestVoucherRetrievalUnavailableError extends Error {}

/** Shared authorization boundary for web and trusted USSD adapters. */
export class GuestVoucherRetrievalService {
  constructor(
    private readonly query: GuestOrderStatusQuery,
    private readonly limiter: OrderRateLimiter,
    private readonly deliveries: CustomerVoucherRetrieval,
  ) {}

  async lookup(input: { phoneNumber: string; orderReference: string }) {
    const phoneNumber = normalizeGhanaPhoneNumber(input.phoneNumber);
    const orderReference = normalizeOrderPublicReference(input.orderReference);
    await this.limiter.consume({ phoneNumber });
    return this.query.findByPhoneAndReference(phoneNumber, orderReference);
  }

  async request(input: {
    readonly orderReference: string;
    readonly contact: unknown;
    readonly idempotencyKey: string;
    readonly clientIp?: string;
  }) {
    const orderReference = normalizeOrderPublicReference(input.orderReference);
    const contact = parseGuestVoucherRetrievalRequest(input.contact);
    const idempotencyKey = assertOrderIdempotencyKey(input.idempotencyKey);
    await this.limiter.consume({
      clientIp: input.clientIp,
      phoneNumber: contact.phoneNumber ?? `email:${contact.email}`,
    });
    const access = await this.query.findVoucherRetrievalAccess({
      ...contact,
      orderReference,
    });
    if (access === null) throw new GuestVoucherRetrievalUnavailableError();
    return this.deliveries.request({ ...access, idempotencyKey });
  }
}
