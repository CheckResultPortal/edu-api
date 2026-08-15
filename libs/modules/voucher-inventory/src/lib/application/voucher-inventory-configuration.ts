import { createSecretKeyring, type SecretKeyring } from '@edu-api/encryption';

export interface VoucherInventoryConfiguration {
  readonly importChunkSize: number;
  readonly importMaxBytes: number;
  readonly importStaleAfterMs: number;
  readonly pinFingerprintKey: string;
  readonly secretEncryptionKey: string;
  readonly secretEncryptionKeyId: string;
}

export function createVoucherInventoryKeyring(
  configuration: VoucherInventoryConfiguration,
): SecretKeyring {
  return createSecretKeyring({
    activeKeyId: configuration.secretEncryptionKeyId,
    fingerprintKey: decodeBase64UrlVoucherKey(configuration.pinFingerprintKey),
    keys: [
      {
        id: configuration.secretEncryptionKeyId,
        material: decodeBase64UrlVoucherKey(configuration.secretEncryptionKey),
      },
    ],
  });
}

export function decodeBase64UrlVoucherKey(value: string): Uint8Array {
  const key = Buffer.from(value, 'base64url');
  if (key.byteLength !== 32) {
    throw new Error('Voucher cryptographic keys must decode to 32 bytes.');
  }
  return key;
}
