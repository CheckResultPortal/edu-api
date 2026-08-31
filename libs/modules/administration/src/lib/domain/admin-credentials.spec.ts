import {
  createAdminBearer,
  createTotpProvisioningUri,
  fingerprintAdminBearer,
  generateTotpSecret,
  hashAdminPassword,
  verifyAdminPassword,
  verifyTotpCode,
} from './admin-credentials';
describe('admin credentials', () => {
  it('derives and verifies a password without preserving plaintext', async () => {
    const hash = await hashAdminPassword('correct horse battery staple');
    expect(hash).not.toContain('correct horse');
    await expect(
      verifyAdminPassword('correct horse battery staple', hash),
    ).resolves.toBe(true);
    await expect(
      verifyAdminPassword('wrong password here', hash),
    ).resolves.toBe(false);
  });
  it('generates and verifies a time-based second factor', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(verifyTotpCode('JBSWY3DPEHPK3PXP', '282760', 0)).toBe(true);
  });

  it('uses context-separated fingerprints for opaque bearers', () => {
    const bearer = createAdminBearer();
    const key = Buffer.alloc(32, 7);
    expect(bearer).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fingerprintAdminBearer(bearer, key, 'admin-session')).not.toBe(
      fingerprintAdminBearer(bearer, key, 'admin-auth-challenge'),
    );
  });

  it('creates a standards-compatible Authenticator provisioning URI', () => {
    const uri = createTotpProvisioningUri({
      accountName: 'admin@example.test',
      issuer: 'EduVoucher',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    expect(uri).toBe(
      'otpauth://totp/EduVoucher%3Aadmin%40example.test?algorithm=SHA1&digits=6&issuer=EduVoucher&period=30&secret=JBSWY3DPEHPK3PXP',
    );
  });

});
