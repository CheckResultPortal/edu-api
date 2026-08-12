import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';

export interface EncryptionKey {
  readonly id: string;
  readonly material: Uint8Array;
}

export interface SecretKeyring {
  readonly activeKeyId: string;
  readonly fingerprintKey: Uint8Array;
  readonly keys: ReadonlyMap<string, Uint8Array>;
}

export interface EncryptedSecret {
  readonly algorithm: 'aes-256-gcm';
  readonly authTag: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly keyId: string;
}

export function createSecretKeyring(input: {
  readonly activeKeyId: string;
  readonly fingerprintKey: Uint8Array;
  readonly keys: readonly EncryptionKey[];
}): SecretKeyring {
  assertKeyLength('fingerprintKey', input.fingerprintKey);

  const keys = new Map<string, Uint8Array>();
  for (const key of input.keys) {
    if (key.id.trim().length === 0 || keys.has(key.id)) {
      throw new Error(
        'Encryption key identifiers must be unique and non-empty.',
      );
    }
    assertKeyLength('encryption key', key.material);
    keys.set(key.id, Buffer.from(key.material));
  }

  if (!keys.has(input.activeKeyId)) {
    throw new Error('Active encryption key must exist in the keyring.');
  }

  return {
    activeKeyId: input.activeKeyId,
    fingerprintKey: Buffer.from(input.fingerprintKey),
    keys,
  };
}

export function encryptSecret(
  plaintext: string,
  keyring: SecretKeyring,
): EncryptedSecret {
  const key = requiredKey(keyring, keyring.activeKeyId);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return {
    algorithm: 'aes-256-gcm',
    authTag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    iv: iv.toString('base64url'),
    keyId: keyring.activeKeyId,
  };
}

export function decryptSecret(
  encrypted: EncryptedSecret,
  keyring: SecretKeyring,
): string {
  if (encrypted.algorithm !== 'aes-256-gcm') {
    throw new Error('Unsupported encrypted secret algorithm.');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    requiredKey(keyring, encrypted.keyId),
    Buffer.from(encrypted.iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function fingerprintSecret(
  plaintext: string,
  keyring: SecretKeyring,
): string {
  return createHmac('sha256', keyring.fingerprintKey)
    .update(plaintext, 'utf8')
    .digest('base64url');
}

function requiredKey(keyring: SecretKeyring, keyId: string): Uint8Array {
  const key = keyring.keys.get(keyId);
  if (key === undefined) {
    throw new Error('Encrypted secret references an unavailable key.');
  }
  return key;
}

function assertKeyLength(field: string, key: Uint8Array): void {
  if (key.byteLength !== 32) {
    throw new Error(field + ' must contain exactly 32 bytes.');
  }
}
