import { createSecretKeyring, type SecretKeyring } from '@edu-api/encryption';

import type { AdminIdentityConfiguration } from './administration-types';

export function createAdminIdentityKeyring(
  configuration: AdminIdentityConfiguration,
): SecretKeyring {
  return createSecretKeyring({
    activeKeyId: configuration.secretEncryptionKeyId,
    fingerprintKey: configuration.hmacKey,
    keys: [
      {
        id: configuration.secretEncryptionKeyId,
        material: configuration.secretEncryptionKey,
      },
    ],
  });
}

export function decodeBase64UrlKey(value: string): Uint8Array {
  const key = Buffer.from(value, 'base64url');
  if (key.byteLength !== 32) {
    throw new Error('Expected a 32-byte base64url key.');
  }
  return key;
}
