import type {
  CanonicalUssdRequest,
  CanonicalUssdResponse,
  UssdProvider,
} from '../application/ussd-provider';
import { UssdRequestError } from '../application/ussd-errors';
import { paymentPromptInstructions } from './payment-prompt-instructions';

export interface NaloUssdProviderConfiguration {
  /** The USERID Nalo assigned to this service; untrusted payloads must match. */
  readonly expectedUserId: string;
}

interface ParsedNaloPayload {
  readonly msisdn: string;
  readonly input: string;
  readonly isNewSession: boolean;
  readonly sessionId: string;
  readonly network?: string;
  readonly userId: string;
}

const MOOLRE_CHANNEL_BY_NALO_NETWORK: Readonly<Record<string, string>> = {
  MTN: '13',
  TELECEL: '6',
  VODAFONE: '6',
  AIRTELTIGO: '7',
};

/**
 * Translates the Nalo USSD HTTP contract into canonical requests/responses.
 * Nalo field names and session semantics stay inside this adapter.
 */
export class NaloUssdProvider implements UssdProvider {
  constructor(private readonly configuration: NaloUssdProviderConfiguration) {}

  parseRequest(input: unknown): CanonicalUssdRequest {
    if (!isPlainObject(input)) throw new UssdRequestError();
    const userId = requiredString(input, 'USERID', 1, 64);
    if (userId !== this.configuration.expectedUserId) {
      throw new UssdRequestError();
    }
    const parsed: ParsedNaloPayload = {
      input: requiredString(input, 'USERDATA', 0, 182),
      isNewSession: requiredMessageType(input, 'MSGTYPE'),
      msisdn: requireMsisdn(input),
      sessionId: requiredString(input, 'SESSIONID', 1, 128),
      network: optionalString(input, 'NETWORK', 32),
      userId,
    };
    return {
      input: parsed.input,
      isNewSession: parsed.isNewSession,
      msisdn: parsed.msisdn,
      sessionId: parsed.sessionId,
      paymentPromptInstructions: paymentPromptInstructions(
        parsed.network === undefined
          ? undefined
          : resolveMoolreChannel(parsed.network),
      ),
      ...(parsed.network === undefined ? {} : { network: parsed.network }),
      ...(parsed.network === undefined
        ? {}
        : { moolreChannel: resolveMoolreChannel(parsed.network) }),
    };
  }

  buildResponse(
    request: CanonicalUssdRequest,
    response: CanonicalUssdResponse,
  ): Record<string, unknown> {
    return {
      MSG: response.message,
      MSGTYPE: response.continueSession,
      MSISDN: request.msisdn,
      USERID: this.configuration.expectedUserId,
      USERDATA: request.input,
    };
  }
}

function requireMsisdn(value: Readonly<Record<string, unknown>>): string {
  const entry = value['MSISDN'];
  if (typeof entry !== 'string' || !/^\d{12}$/.test(entry)) {
    throw new UssdRequestError();
  }
  return entry;
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  minimumLength: number,
  maximumLength: number,
): string {
  const entry = value[key];
  if (
    typeof entry !== 'string' ||
    entry.length < minimumLength ||
    entry.length > maximumLength
  ) {
    throw new UssdRequestError();
  }
  return entry;
}

function requiredMessageType(
  value: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  const entry = value[key];
  if (typeof entry === 'boolean') return entry;
  if (entry === 1 || entry === '1') return true;
  if (entry === 0 || entry === '0') return false;
  if (typeof entry === 'string') {
    const normalized = entry.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  throw new UssdRequestError();
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maximumLength: number,
): string | undefined {
  const entry = value[key];
  if (entry === undefined) return undefined;
  if (
    typeof entry !== 'string' ||
    entry.length === 0 ||
    entry.length > maximumLength
  ) {
    throw new UssdRequestError();
  }
  return entry;
}

function resolveMoolreChannel(network: string): string | undefined {
  const normalized = network
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '');
  return MOOLRE_CHANNEL_BY_NALO_NETWORK[normalized];
}

function isPlainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
