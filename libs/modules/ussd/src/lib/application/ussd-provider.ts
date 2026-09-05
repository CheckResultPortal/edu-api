export const USSD_PROVIDER = Symbol('USSD_PROVIDER');

/** Provider-neutral incoming USSD request. */
export interface CanonicalUssdRequest {
  /** Raw customer number as sent by the gateway (e.g. 233XXXXXXXXX). */
  readonly msisdn: string;
  /** The customer's input for this screen. */
  readonly input: string;
  /** True when the gateway signals an initial dial. */
  readonly isNewSession: boolean;
  /** Gateway session identifier. Used as the Redis session key when supplied. */
  readonly sessionId?: string;
  /** Gateway network label, retained for payment-provider routing. */
  readonly network?: string;
  /** Moolre collection channel derived from the gateway network. */
  readonly moolreChannel?: string;
  /** Safe network-wallet guidance supplied by the gateway adapter. */
  readonly paymentPromptInstructions?: string;
}

/** Provider-neutral outgoing USSD screen. */
export interface CanonicalUssdResponse {
  readonly message: string;
  readonly continueSession: boolean;
}

export interface UssdProvider {
  /**
   * Validates provider identity and field shapes. Throws UssdRequestError
   * when the payload cannot be trusted.
   */
  parseRequest(input: unknown): CanonicalUssdRequest;

  buildResponse(
    request: CanonicalUssdRequest,
    response: CanonicalUssdResponse,
  ): unknown;
}
