import type {
  EmailProvider,
  EmailProviderFailureCategory,
  SendEmailInput,
  SendEmailResult,
} from '../application/email-provider';

const resendUserAgent = 'eduvoucher-api/1.0';

export interface ResendEmailProviderOptions {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
}

/** Resend-specific HTTP, status handling, and idempotency header stay here. */
export class ResendEmailProvider implements EmailProvider {
  readonly idempotencyRetentionMs = 24 * 60 * 60 * 1000;

  private readonly fetcher: typeof fetch;

  constructor(private readonly options: ResendEmailProviderOptions) {
    this.fetcher = options.fetch ?? fetch;
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    try {
      const response = await this.fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
          'User-Agent': resendUserAgent,
        },
        body: JSON.stringify({
          from: input.from,
          to: [input.to],
          subject: input.subject,
          html: input.html,
          text: input.text,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok && isObject(payload) && typeof payload.id === 'string') {
        return { status: 'SENT', providerMessageId: payload.id };
      }
      return {
        status: 'FAILED',
        category: classifyResendFailure(response.status),
        ...(isObject(payload) && typeof payload.name === 'string'
          ? { providerCode: payload.name }
          : {}),
      };
    } catch {
      return { status: 'FAILED', category: 'UNKNOWN_OUTCOME' };
    }
  }
}

function classifyResendFailure(status: number): EmailProviderFailureCategory {
  if (status === 401 || status === 403) return 'AUTHENTICATION';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400 || status === 422) return 'INVALID_REQUEST';
  if (status >= 500) return 'TEMPORARY';
  return 'PERMANENT';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
