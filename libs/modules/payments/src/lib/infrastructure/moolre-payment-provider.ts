import { createHash, timingSafeEqual } from 'node:crypto';

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

export interface MoolrePaymentProviderConfiguration {
  readonly webhookSecret?: string;
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;
  /** Moolre username sent as X-API-USER. */
  readonly apiUser: string;
  /** Public API key sent as X-API-PUBKEY. */
  readonly publicKey: string;
  /** Collection wallet account number. Must be denominated in GHS. */
  readonly accountNumber: string;
}

const MOOLRE_COLLECTION_PATH = 'open/transact/payment';
const MOOLRE_STATUS_PATH = 'open/transact/status';

const CHANNEL_MTN = '13';
const CHANNEL_TELECEL = '6';
const CHANNEL_AT = '7';

const CODE_PAYMENT_INITIATED = 'TR099';
const CODE_OTP_REQUIRED = 'TP14';
const CODE_DUPLICATE_REFERENCE = 'TP13';
const CODE_TRANSACTION_FOUND = 'SS01';

interface MoolreEnvelope {
  readonly status?: number | string;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly data?: unknown;
}

export class MoolrePaymentProvider implements PaymentProvider {
  readonly code = 'MOOLRE';
  private readonly baseUrl: URL;

  constructor(
    private readonly configuration: MoolrePaymentProviderConfiguration,
  ) {
    this.baseUrl = new URL(configuration.baseUrl);
    if (!this.baseUrl.pathname.endsWith('/')) {
      this.baseUrl.pathname = `${this.baseUrl.pathname}/`;
    }
  }

  /**
   * Moolre collection callbacks authenticate with data.secret. The returned
   * NOTIFICATION must still be re-verified through verify()
   * before any success effect is committed.
   */
  authenticateWebhook(
    rawBody: Buffer,
    _signature: string | undefined,
  ): AuthenticatedProviderWebhook {
    const payload = parseJsonObject(rawBody.toString('utf8'));
    const data = requiredObject(payload, 'data');
    const secret = data['secret'];
    const expected = this.configuration.webhookSecret;
    if (
      typeof secret !== 'string' ||
      !secret ||
      !expected ||
      !timingSafeEqual(
        createHash('sha256').update(secret).digest(),
        createHash('sha256').update(expected).digest(),
      )
    ) {
      throw new PaymentWebhookAuthenticationError();
    }
    const code = payload['code'];
    if (typeof code !== 'string' || code.length === 0 || code.length > 32) {
      throw new PaymentWebhookPayloadError();
    }
    if (code !== 'P01') return { kind: 'IGNORED' };

    const status = payload['status'];
    if (typeof status !== 'number' || !Number.isInteger(status)) {
      throw new PaymentWebhookPayloadError();
    }
    const providerReference = requiredReference(data, 'externalref');

    return {
      eventType: code,
      kind: 'NOTIFICATION',
      payloadFingerprint: createHash('sha256').update(rawBody).digest('hex'),
      providerReference,
    };
  }

  async initialize(
    input: InitializeProviderPaymentInput,
  ): Promise<InitializedProviderPayment> {
    const payer = input.payerPhoneNumber;
    if (payer === undefined) {
      throw new PaymentProviderRequestError('INVALID_REQUEST');
    }
    const channel = input.moolreChannel ?? moolreChannelForPhoneNumber(payer);
    if (channel === null) {
      throw new PaymentProviderRequestError('INVALID_REQUEST');
    }
    if (input.currency !== 'GHS') {
      throw new PaymentProviderRequestError('INVALID_REQUEST');
    }

    const payload = await this.request(MOOLRE_COLLECTION_PATH, {
      type: 1,
      accountnumber: this.configuration.accountNumber,
      amount: formatMajorAmount(input.amountMinor),
      channel,
      currency: input.currency,
      externalref: input.providerReference,
      payer,
    });

    if (payload.code === CODE_OTP_REQUIRED) {
      // The prompt was not delivered until the customer completes the SMS
      // verification flow. Treated as temporary: the recovery worker keeps
      // polling the status endpoint while the customer completes it.
      throw new PaymentProviderRequestError('TEMPORARY');
    }
    if (payload.code === CODE_DUPLICATE_REFERENCE) {
      throw new PaymentProviderRequestError('INVALID_REQUEST');
    }
    if (payload.status !== 1 && payload.status !== '1') {
      throw new PaymentProviderRequestError('INVALID_REQUEST');
    }

    return {
      accessCode: null,
      authorizationUrl: null,
      providerReference: input.providerReference,
    };
  }

  async verify(
    providerReference: string,
  ): Promise<ProviderPaymentVerification> {
    const payload = await this.request(MOOLRE_STATUS_PATH, {
      type: 1,
      accountnumber: this.configuration.accountNumber,
      id: providerReference,
      idtype: 1,
    });

    if (
      payload.code !== CODE_TRANSACTION_FOUND ||
      !isPlainObject(payload.data)
    ) {
      // The transaction may not be recorded yet; the status check is
      // idempotent so treat as retryable rather than terminal.
      throw new PaymentProviderRequestError('TEMPORARY');
    }

    const txstatus = payload.data['txstatus'];
    if (typeof txstatus !== 'number' || !Number.isInteger(txstatus)) {
      throw new PaymentProviderRequestError('UNKNOWN_OUTCOME');
    }
    if (txstatus !== 1) {
      return {
        isTerminal: txstatus === 2,
        kind: 'NOT_SUCCEEDED',
        providerStatus: `txstatus_${txstatus}`,
      };
    }

    return {
      kind: 'PAYMENT_SUCCEEDED',
      success: parseVerifiedSuccess(payload.data, providerReference),
    };
  }

  private async request(
    path: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<MoolreEnvelope> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-user': this.configuration.apiUser,
          'x-api-pubkey': this.configuration.publicKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.configuration.requestTimeoutMs),
      });
    } catch {
      throw new PaymentProviderRequestError('UNKNOWN_OUTCOME');
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new PaymentProviderRequestError('AUTHENTICATION');
      }
      if (response.status >= 400 && response.status < 500) {
        throw new PaymentProviderRequestError('INVALID_REQUEST');
      }
      throw new PaymentProviderRequestError('UNKNOWN_OUTCOME');
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

/**
 * Resolves the Moolre collection channel from a Ghana mobile prefix.
 * Returns null for numbers that cannot be routed.
 */
export function moolreChannelForPhoneNumber(
  phoneNumber: string,
): string | null {
  const normalized = phoneNumber.replace(/[\s()-]/g, '');
  const local = normalized.startsWith('+233')
    ? `0${normalized.slice(4)}`
    : normalized;
  if (!/^0[0-9]{9}$/.test(local)) return null;
  const prefix = local.slice(0, 3);
  if (['024', '025', '053', '054', '055', '059'].includes(prefix)) {
    return CHANNEL_MTN;
  }
  if (['020', '050'].includes(prefix)) return CHANNEL_TELECEL;
  if (['026', '027', '056', '057'].includes(prefix)) return CHANNEL_AT;
  return null;
}

/** Converts minor units to the 2-decimal major-unit string Moolre expects. */
export function formatMajorAmount(amountMinor: bigint): string {
  if (amountMinor < BigInt(1)) {
    throw new PaymentProviderRequestError('INVALID_REQUEST');
  }
  const cedis = amountMinor / BigInt(100);
  const pesewas = amountMinor % BigInt(100);
  return `${cedis}.${pesewas.toString().padStart(2, '0')}`;
}

function parseVerifiedSuccess(
  data: Readonly<Record<string, unknown>>,
  expectedReference: string,
): VerifiedProviderPaymentSuccess {
  const externalref = requiredReference(data, 'externalref');
  if (externalref !== expectedReference) {
    throw new PaymentProviderRequestError('UNKNOWN_OUTCOME');
  }
  const transactionid = data['transactionid'];
  if (
    typeof transactionid !== 'string' ||
    !/^[0-9]{1,32}$/.test(transactionid)
  ) {
    throw new PaymentProviderRequestError('UNKNOWN_OUTCOME');
  }
  const amount = data['amount'];
  if (typeof amount !== 'string' || !/^\d{1,10}(\.\d{1,2})?$/.test(amount)) {
    throw new PaymentProviderRequestError('UNKNOWN_OUTCOME');
  }
  const ts = data['ts'];
  if (
    typeof ts !== 'string' ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts)
  ) {
    throw new PaymentProviderRequestError('UNKNOWN_OUTCOME');
  }
  const paidAt = new Date(`${ts}Z`);
  if (Number.isNaN(paidAt.getTime())) {
    throw new PaymentProviderRequestError('UNKNOWN_OUTCOME');
  }

  return {
    // The status endpoint does not echo currency; the configured collection
    // wallet is GHS-only, which this provider enforces at initialization.
    amountMinor: parseMinorAmount(amount),
    currency: 'GHS',
    paidAt,
    providerReference: externalref,
    providerStatus: 'success',
    providerTransactionId: transactionid,
  };
}

function parseMinorAmount(majorAmount: string): bigint {
  const [whole, fraction = ''] = majorAmount.split('.');
  const paddedFraction = fraction.padEnd(2, '0').slice(0, 2);
  return BigInt(`${whole}${paddedFraction}`);
}

function requiredObject(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const entry = value[key];
  if (!isPlainObject(entry)) throw new PaymentWebhookPayloadError();
  return entry;
}

function requiredReference(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const entry = value[key];
  if (
    typeof entry !== 'string' ||
    entry.length < 1 ||
    entry.length > 200 ||
    entry !== entry.trim()
  ) {
    throw new PaymentWebhookPayloadError();
  }
  return entry;
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

function isPlainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
