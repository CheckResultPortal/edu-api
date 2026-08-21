export type SmsProviderFailureCategory =
  | 'AUTHENTICATION'
  | 'INVALID_REQUEST'
  | 'PERMANENT'
  | 'RATE_LIMITED'
  | 'TEMPORARY'
  | 'UNKNOWN_OUTCOME';

export interface SendSmsInput {
  readonly message: string;
  /** A durable, provider-visible reference. It is reused for every safe retry. */
  readonly reference: string;
  readonly to: string;
}

export type SendSmsResult =
  | { readonly providerMessageId: string; readonly status: 'SENT' }
  | {
      readonly category: SmsProviderFailureCategory;
      readonly providerCode?: string;
      readonly status: 'FAILED';
    };

export type SmsLookupResult = 'ACCEPTED' | 'NOT_FOUND' | 'UNKNOWN';

export interface SmsProvider {
  readonly name: string;

  send(input: SendSmsInput): Promise<SendSmsResult>;
  lookup(reference: string): Promise<SmsLookupResult>;
}
