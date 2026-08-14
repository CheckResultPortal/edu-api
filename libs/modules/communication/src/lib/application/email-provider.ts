export type EmailProviderFailureCategory =
  | 'AUTHENTICATION'
  | 'INVALID_REQUEST'
  | 'PERMANENT'
  | 'RATE_LIMITED'
  | 'TEMPORARY'
  | 'UNKNOWN_OUTCOME';

export interface SendEmailInput {
  readonly from: string;
  readonly html: string;
  readonly idempotencyKey: string;
  readonly subject: string;
  readonly text: string;
  readonly to: string;
}

export interface SendEmailSuccess {
  readonly providerMessageId: string;
  readonly status: 'SENT';
}

export interface SendEmailFailure {
  readonly category: EmailProviderFailureCategory;
  readonly providerCode?: string;
  readonly status: 'FAILED';
}

export type SendEmailResult = SendEmailFailure | SendEmailSuccess;

export interface EmailProvider {
  /** The period in which the provider guarantees idempotency-key replay. */
  readonly idempotencyRetentionMs: number;

  send(input: SendEmailInput): Promise<SendEmailResult>;
}
