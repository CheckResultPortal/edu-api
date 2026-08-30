import { isIP } from 'node:net';

export const NALO_GATEWAY_ACCESS_POLICY = Symbol('NALO_GATEWAY_ACCESS_POLICY');

export interface NaloGatewayAccessPolicyConfiguration {
  readonly enabled: boolean;
  /** Comma-separated Nalo egress addresses supplied through secure deployment configuration. */
  readonly trustedSourceIps?: string;
}

/**
 * USERID is routing metadata, not webhook authentication. A live Nalo route
 * therefore accepts callbacks only from explicitly configured gateway egress
 * addresses. This boundary relies on the application's configured proxy hops.
 */
export class NaloGatewayAccessPolicy {
  private readonly trustedSourceIps: ReadonlySet<string>;

  constructor(
    private readonly configuration: NaloGatewayAccessPolicyConfiguration,
  ) {
    this.trustedSourceIps = configuration.enabled
      ? parseTrustedSourceIps(configuration.trustedSourceIps)
      : new Set();
  }

  get enabled(): boolean {
    return this.configuration.enabled;
  }

  allows(clientIp: string): boolean {
    const normalized = normalizeIp(clientIp);
    return normalized !== null && this.trustedSourceIps.has(normalized);
  }
}

function parseTrustedSourceIps(value: string | undefined): ReadonlySet<string> {
  if (value === undefined) {
    throw new Error(
      'NALO_TRUSTED_SOURCE_IPS is required when USSD is enabled.',
    );
  }
  const ips = value.split(',').map((entry) => normalizeIp(entry));
  if (ips.length === 0 || ips.some((entry) => entry === null)) {
    throw new Error(
      'NALO_TRUSTED_SOURCE_IPS must contain only comma-separated IP addresses.',
    );
  }
  return new Set(ips as string[]);
}

function normalizeIp(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const withoutIpv4MappedPrefix = trimmed.startsWith('::ffff:')
    ? trimmed.slice('::ffff:'.length)
    : trimmed;
  return isIP(withoutIpv4MappedPrefix) === 0 ? null : withoutIpv4MappedPrefix;
}
