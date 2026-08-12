import {
  canonicalizeJson,
  createRequestFingerprint,
} from './request-fingerprint';

describe('request fingerprint', () => {
  it('is stable across object key order', () => {
    expect(createRequestFingerprint({ b: 2, a: ['x', true] })).toBe(
      createRequestFingerprint({ a: ['x', true], b: 2 }),
    );
  });

  it('distinguishes different request payloads', () => {
    expect(createRequestFingerprint({ quantity: 1 })).not.toBe(
      createRequestFingerprint({ quantity: 2 }),
    );
  });

  it('rejects non-JSON external values', () => {
    expect(() => canonicalizeJson({ createdAt: new Date() })).toThrow(
      'plain objects',
    );
  });
});
