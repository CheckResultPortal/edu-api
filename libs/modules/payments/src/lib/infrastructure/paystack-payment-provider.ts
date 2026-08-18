import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  PaymentWebhookAuthenticationError,
  PaymentWebhookPayloadError,
} from '../application/payment-errors';
import {
  PaymentProviderRequestError,
  type AuthenticatedProviderWebhook,
  type InitializeProviderPaymentInput,
  type InitializedProviderPayment,
  type PaymentProvider,
  type ProviderPaymentVerification,
  type VerifiedProviderPaymentSuccess,
} from '../application/payment-provider';

export interface PaystackPaymentProviderConfiguration {
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;
  readonly secretKey: string;
}

export class PaystackPaymentProvider implements PaymentProvider {
  readonly code = 'PAYSTACK';
  private readonly baseUrl: URL;

  constructor(
    private readonly configuration: PaystackPaymentProviderConfiguration,
  ) {
    this.baseUrl = new URL(configuration.baseUrl);
    if (!this.baseUrl.pathname.endsWith('/')) {
      this.baseUrl.pathname = `${this.baseUrl.pathname}/`;
    }
  }

  authenticateWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): AuthenticatedProviderWebhook {
    if (signature === undefined || !/^[0-9a-f]{128}$/i.test(signature)) {
      throw new PaymentWebhookAuthenticationError();
    }
    const expected = createHmac('sha512', this.configuration.secretKey)
      .update(rawBody)
      .digest();
    const received = Buffer.from(signature, 'hex');
    if (
      received.byteLength !== expected.byteLength ||
      !timingSafeEqual(received, expected)
    ) {
      throw new PaymentWebhookAuthenticationError();
    }

    const payload = parseJsonObject(rawBody.toString('utf8'));
    const eventType = requiredString(payload, 'event');
    if (eventType !== 'charge.success') return { kind: 'IGNORED' };
    const data = requiredObject(payload, 'data');

    return {
      eventType,
      kind: 'PAYMENT_SUCCEEDED',
      payloadFingerprint: createHash('sha256').update(rawBody).digest('hex'),
      success: parseSuccessfulPayment(data),
    };
  }

  async initialize(
    input: InitializeProviderPaymentInput,
  ): Promise<InitializedProviderPayment> {
    const amount = safeProviderInteger(input.amountMinor);
    const payload = await this.request('transaction/initialize', 'POST', {
      amount,
      callback_url: input.callbackUrl,
      currency: input.currency,
      email: input.email,
      metadata: {
        order_reference: input.orderPublicReference,
        payment_reference: input.paymentPublicReference,
      },
      reference: input.providerReference,
    });
    if (payload['status'] !== true) {
      throw new PaymentProviderRequestError('INVALID_REQUEST');
    }
    const data = requiredProviderObject(payload, 'data');
    const providerReference = requiredProviderString(data, 'reference', 200);
    if (providerReference !== input.providerReference) {
      throw new PaymentProviderRequestError('UNKNOWN_OUTCOME');
    }

    return {
      accessCode: requiredProviderString(data, 'access_code', 256),
      authorizationUrl: requiredProviderUrl(data, 'authorization_url'),
      providerReference,
    };
  }

  async verify(
    providerReference: string,
  ): Promise<ProviderPaymentVerification> {
    const payload = await this.request(
      `transaction/verify/${encodeURIComponent(providerReference)}`,
      'GET',
    );
    if (payload['status'] !== true) {
      throw new PaymentProviderRequestError('TEMPORARY');
    }
    const data = requiredProviderObject(payload, 'data');
    const returnedReference = requiredProviderString(data, 'reference', 200);
    if (returnedReference !== providerReference) {
      throw new PaymentProviderRequestError('UNKNOWN_OUTCOME');
    }
    const providerStatus = requiredProviderString(
      data,
      'status',
      100,
    ).toLowerCase();
    if (providerStatus === 'success') {
      return { kind: 'PAYMENT_SUCCEEDED', success: parseProviderSuccess(data) };
    }

    return {
      isTerminal: ['abandoned', 'failed', 'reversed'].includes(providerStatus),
      kind: 'NOT_SUCCEEDED',
      providerStatus,
    };
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: {
          authorization: `Bearer ${this.configuration.secretKey}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.configuration.requestTimeoutMs),
      });
    } catch {
      throw new PaymentProviderRequestError(
        method === 'POST' ? 'UNKNOWN_OUTCOME' : 'TEMPORARY',
      );
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new PaymentProviderRequestError('AUTHENTICATION');
      }
      if (response.status >= 400 && response.status < 500) {
        throw new PaymentProviderRequestError('INVALID_REQUEST');
      }
      throw new PaymentProviderRequestError(
        method === 'POST' ? 'UNKNOWN_OUTCOME' : 'TEMPORARY',
      );
    }

    try {
      const value: unknown = await response.json();
      if (!isPlainObject(value)) throw new Error('not an object');
      return value;
    } catch {
      throw new PaymentProviderRequestError('UNKNOWN_OUTCOME');
    }
  }
}

function parseSuccessfulPayment(
  data: Readonly<Record<string, unknown>>,
): VerifiedProviderPaymentSuccess {
  try {
    return parseProviderSuccess(data);
  } catch (error) {
    if (error instanceof PaymentWebhookPayloadError) throw error;
    throw new PaymentWebhookPayloadError();
  }
}

function parseProviderSuccess(
  data: Readonly<Record<string, unknown>>,
): VerifiedProviderPaymentSuccess {
  const amount = data['amount'];
  if (
    typeof amount !== 'number' ||
    !Number.isSafeInteger(amount) ||
    amount < 1
  ) {
    throw new PaymentWebhookPayloadError();
  }
  const providerStatus = requiredString(data, 'status').toLowerCase();
  if (providerStatus !== 'success') throw new PaymentWebhookPayloadError();
  const paidAtValue = data['paid_at'];
  if (typeof paidAtValue !== 'string') throw new PaymentWebhookPayloadError();
  const paidAt = new Date(paidAtValue);
  if (Number.isNaN(paidAt.getTime())) throw new PaymentWebhookPayloadError();

  return {
    amountMinor: BigInt(amount),
    currency: requiredString(data, 'currency').toUpperCase(),
    paidAt,
    providerReference: requiredString(data, 'reference'),
    providerStatus,
    providerTransactionId: providerTransactionId(data['id']),
  };
}

function providerTransactionId(value: unknown): string {
  if (typeof value === 'string' && /^[1-9]\d{0,99}$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  throw new PaymentWebhookPayloadError();
}

function safeProviderInteger(value: bigint): number {
  if (value < BigInt(1) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PaymentProviderRequestError('INVALID_REQUEST');
  }
  return Number(value);
}

function parseJsonObject(value: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isPlainObject(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new PaymentWebhookPayloadError();
  }
}

function requiredObject(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const entry = value[key];
  if (!isPlainObject(entry)) throw new PaymentWebhookPayloadError();
  return entry;
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const entry = value[key];
  if (typeof entry !== 'string' || entry.length < 1 || entry.length > 200) {
    throw new PaymentWebhookPayloadError();
  }
  return entry;
}

function requiredProviderObject(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const entry = value[key];
  if (!isPlainObject(entry)) {
    throw new PaymentProviderRequestError('UNKNOWN_OUTCOME');
  }
  return entry;
}

function requiredProviderString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maximumLength: number,
): string {
  const entry = value[key];
  if (
    typeof entry !== 'string' ||
    entry.length < 1 ||
    entry.length > maximumLength
  ) {
    throw new PaymentProviderRequestError('UNKNOWN_OUTCOME');
  }
  return entry;
}

function requiredProviderUrl(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const entry = requiredProviderString(value, key, 2048);
  try {
    const url = new URL(entry);
    if (url.protocol !== 'https:') throw new Error('not HTTPS');
    return url.toString();
  } catch {
    throw new PaymentProviderRequestError('UNKNOWN_OUTCOME');
  }
}

function isPlainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
