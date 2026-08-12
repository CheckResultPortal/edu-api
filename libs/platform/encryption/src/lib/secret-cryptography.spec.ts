import {
  createSecretKeyring,
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
} from './secret-cryptography';

describe('secret cryptography', () => {
  const keyring = createSecretKeyring({
    activeKeyId: 'key-2026',
    fingerprintKey: Buffer.alloc(32, 7),
    keys: [
      { id: 'key-2025', material: Buffer.alloc(32, 5) },
      { id: 'key-2026', material: Buffer.alloc(32, 6) },
    ],
  });

  it('encrypts and decrypts with the active key identifier', () => {
    const encrypted = encryptSecret('voucher-pin-123', keyring);

    expect(encrypted.keyId).toBe('key-2026');
    expect(encrypted.ciphertext).not.toContain('voucher-pin-123');
    expect(decryptSecret(encrypted, keyring)).toBe('voucher-pin-123');
  });

  it('supports decrypting records encrypted by a retained previous key', () => {
    const previousKeyring = createSecretKeyring({
      activeKeyId: 'key-2025',
      fingerprintKey: Buffer.alloc(32, 7),
      keys: [
        { id: 'key-2025', material: Buffer.alloc(32, 5) },
        { id: 'key-2026', material: Buffer.alloc(32, 6) },
      ],
    });
    const encrypted = encryptSecret('voucher-pin-123', previousKeyring);

    expect(decryptSecret(encrypted, keyring)).toBe('voucher-pin-123');
  });

  it('creates stable keyed fingerprints without returning the secret', () => {
    const first = fingerprintSecret('voucher-pin-123', keyring);

    expect(first).toBe(fingerprintSecret('voucher-pin-123', keyring));
    expect(first).not.toContain('voucher-pin-123');
  });
});
