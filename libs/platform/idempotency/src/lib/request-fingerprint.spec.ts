import {
  canonicalizeJson,
  createRequestFingerprint,
} from './request-fingerprint';

describe('request fingerprint', () => {
  it('is stable across object key order', () => {
    expect(createRequestFingerprint({ b: 2, a: ['x', true] }, hmacKey)).toBe(
      createRequestFingerprint({ a: ['x', true], b: 2 }, hmacKey),
    );
  });

  it('distinguishes different request payloads', () => {
    expect(createRequestFingerprint({ quantity: 1 }, hmacKey)).not.toBe(
      createRequestFingerprint({ quantity: 2 }, hmacKey),
    );
  });

  it('uses a secret key so the same payload cannot be enumerated offline', () => {
    expect(createRequestFingerprint({ quantity: 1 }, hmacKey)).not.toBe(
      createRequestFingerprint({ quantity: 1 }, Buffer.alloc(32, 8)),
    );
  });

  it('requires a 32-byte HMAC key', () => {
    expect(() =>
      createRequestFingerprint({ quantity: 1 }, Buffer.alloc(16)),
    ).toThrow('32 bytes');
  });

  it('rejects non-JSON external values', () => {
    expect(() => canonicalizeJson({ createdAt: new Date() })).toThrow(
      'plain objects',
    );
  });
});

const hmacKey = Buffer.alloc(32, 7);
