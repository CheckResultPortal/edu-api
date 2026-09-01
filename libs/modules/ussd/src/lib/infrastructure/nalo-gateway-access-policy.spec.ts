import { NaloGatewayAccessPolicy } from './nalo-gateway-access-policy';

describe('NaloGatewayAccessPolicy', () => {
  it('accepts only configured Nalo gateway sources when enabled', () => {
    const policy = new NaloGatewayAccessPolicy({
      enabled: true,
      trustedSourceIps: '203.0.113.10,2001:db8::10',
    });

    expect(policy.allows('203.0.113.10')).toBe(true);
    expect(policy.allows('::ffff:203.0.113.10')).toBe(true);
    expect(policy.allows('198.51.100.10')).toBe(false);
  });

  it('rejects every source while USSD is disabled', () => {
    const policy = new NaloGatewayAccessPolicy({ enabled: false });

    expect(policy.enabled).toBe(false);
    expect(policy.allows('203.0.113.10')).toBe(false);
  });

  it('allows any source when enabled without an optional allowlist', () => {
    const policy = new NaloGatewayAccessPolicy({ enabled: true });

    expect(policy.allows('198.51.100.10')).toBe(true);
  });

  it('rejects an invalid trusted-source configuration at startup', () => {
    expect(
      () =>
        new NaloGatewayAccessPolicy({
          enabled: true,
          trustedSourceIps: '203.0.113.10,not-an-ip',
        }),
    ).toThrow('NALO_TRUSTED_SOURCE_IPS');
  });
});
