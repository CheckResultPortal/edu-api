import type {
  CanonicalUssdRequest,
  CanonicalUssdResponse,
  UssdProvider,
} from '../application/ussd-provider';
import { UssdRequestError } from '../application/ussd-errors';

export interface NaloUssdProviderConfiguration {
  /** The USERID Nalo assigned to this service; untrusted payloads must match. */
  readonly expectedUserId: string;
}

interface ParsedNaloPayload {
  readonly msisdn: string;
  readonly input: string;
  readonly isNewSession: boolean;
  readonly userId: string;
}

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
      isNewSession: requiredBoolean(input, 'MSGTYPE'),
      msisdn: requireMsisdn(input),
      userId,
    };
    return {
      input: parsed.input,
      isNewSession: parsed.isNewSession,
      msisdn: parsed.msisdn,
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
  if (typeof entry !== 'string' || !/^[0-9]{9,15}$/.test(entry)) {
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

function requiredBoolean(
  value: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  const entry = value[key];
  if (typeof entry !== 'boolean') throw new UssdRequestError();
  return entry;
}

function isPlainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
