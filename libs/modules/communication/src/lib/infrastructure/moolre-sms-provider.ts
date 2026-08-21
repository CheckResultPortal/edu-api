import type {
  SmsLookupResult,
  SmsProvider,
  SmsProviderFailureCategory,
  SendSmsInput,
  SendSmsResult,
} from '../application/sms-provider';

export interface MoolreSmsProviderOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
  readonly senderId: string;
  readonly vasKey: string;
}

/** Moolre-specific wire format, headers, and result codes stay in this adapter. */
export class MoolreSmsProvider implements SmsProvider {
  readonly name = 'moolre';
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: MoolreSmsProviderOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? 'https://api.moolre.com').replace(
      /\/$/,
      '',
    );
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    try {
      const response = await this.fetcher(`${this.baseUrl}/open/sms/send`, {
        body: JSON.stringify({
          messages: [
            {
              message: input.message,
              recipient: input.to.replace(/^\+/, ''),
              ref: input.reference,
            },
          ],
          senderid: this.options.senderId,
          type: 1,
        }),
        headers: {
          'Content-Type': 'application/json',
          'X-API-VASKEY': this.options.vasKey,
        },
        method: 'POST',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      const body = await responseJson(response);
      if (response.ok && body?.status === 1) {
        return { providerMessageId: input.reference, status: 'SENT' };
      }
      return {
        category: classifyFailure(response.status, body?.code),
        ...(body?.code === undefined ? {} : { providerCode: body.code }),
        status: 'FAILED',
      };
    } catch {
      return { category: 'UNKNOWN_OUTCOME', status: 'FAILED' };
    }
  }

  async lookup(reference: string): Promise<SmsLookupResult> {
    try {
      const response = await this.fetcher(`${this.baseUrl}/open/sms/status`, {
        body: JSON.stringify({ ref: [reference], type: 5 }),
        headers: {
          'Content-Type': 'application/json',
          'X-API-VASKEY': this.options.vasKey,
        },
        method: 'POST',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      const body = await responseJson(response);
      if (!response.ok || body?.status !== 1 || !Array.isArray(body.data)) {
        return 'UNKNOWN';
      }
      return body.data.some((item) => isObject(item) && item.ref === reference)
        ? 'ACCEPTED'
        : 'NOT_FOUND';
    } catch {
      return 'UNKNOWN';
    }
  }
}

async function responseJson(response: Response): Promise<{
  readonly code?: string;
  readonly data?: unknown;
  readonly status?: number;
} | null> {
  try {
    const value: unknown = await response.json();
    if (!isObject(value)) return null;
    return {
      ...(typeof value.code === 'string' ? { code: value.code } : {}),
      ...(value.data === undefined ? {} : { data: value.data }),
      ...(typeof value.status === 'number' ? { status: value.status } : {}),
    };
  } catch {
    return null;
  }
}

function classifyFailure(
  status: number,
  code: string | undefined,
): SmsProviderFailureCategory {
  if (status === 401 || status === 403 || code === 'AIN01')
    return 'AUTHENTICATION';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'TEMPORARY';
  if (status >= 400 || code === 'ASMS07') return 'INVALID_REQUEST';
  return 'PERMANENT';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
