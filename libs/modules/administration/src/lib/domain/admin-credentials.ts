import * as argon2 from 'argon2';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Used only to give nonexistent, disabled, and locked accounts the same
// Argon2id verification work as an existing account. It is not a credential.
export const dummyAdminPasswordHash =
  '$argon2id$v=19$m=65536,p=1,t=3$77b5ocm6cyK19r0kdLXhDQ$6++ZlrYD3gtXKuJEyxjDKAmxXEfOTu4kI/zx1LVE4lo';

export async function hashAdminPassword(password: string): Promise<string> {
  assertPassword(password);
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
  });
}

export async function verifyAdminPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  try {
    return await argon2.verify(encoded, password);
  } catch {
    return false;
  }
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function verifyTotpCode(
  secret: string,
  code: string,
  now = Date.now(),
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(now / 30_000);
  return [-1, 0, 1]
    .filter((offset) => counter + offset >= 0)
    .some((offset) =>
      timingSafeEqual(
        Buffer.from(totp(secret, counter + offset)),
        Buffer.from(code),
      ),
    );
}

export function fingerprintAdminBearer(
  bearer: string,
  key: Uint8Array,
  purpose = 'admin-bearer',
): string {
  return createHmac('sha256', key)
    .update(purpose, 'utf8')
    .update('\u0000', 'utf8')
    .update(bearer, 'utf8')
    .digest('base64url');
}

export function createAdminBearer(): string {
  return randomBytes(32).toString('base64url');
}

function assertPassword(password: string): void {
  if (password.length < 14 || password.length > 1024)
    throw new Error(
      'Admin password must contain between 14 and 1024 characters.',
    );
}
function totp(secret: string, counter: number): string {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret))
    .update(bytes)
    .digest();
  const offset = digest[digest.length - 1] & 15;
  const value =
    ((digest[offset] & 127) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(value % 1_000_000).padStart(6, '0');
}
function encodeBase32(value: Uint8Array): string {
  let bits = 0,
    buffer = 0,
    result = '';
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += base32Alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits === 0
    ? result
    : result + base32Alphabet[(buffer << (5 - bits)) & 31];
}
function decodeBase32(value: string): Buffer {
  let bits = 0,
    buffer = 0;
  const bytes: number[] = [];
  for (const char of value.replace(/=+$/g, '').toUpperCase()) {
    const index = base32Alphabet.indexOf(char);
    if (index < 0) throw new Error('TOTP secret is not valid base32.');
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
