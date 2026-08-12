import { createHash } from 'node:crypto';

export function createRequestFingerprint(payload: unknown): string {
  return createHash('sha256')
    .update(canonicalizeJson(payload), 'utf8')
    .digest('base64url');
}

export function canonicalizeJson(payload: unknown): string {
  return serialize(payload, new WeakSet<object>());
}

function serialize(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Request fingerprint payload numbers must be finite.');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return serializeArray(value, ancestors);
  }

  if (typeof value === 'object') {
    return serializeObject(value, ancestors);
  }

  throw new Error('Request fingerprint payload must be JSON-compatible.');
}

function serializeArray(
  value: readonly unknown[],
  ancestors: WeakSet<object>,
): string {
  if (ancestors.has(value)) {
    throw new Error('Request fingerprint payload must not be circular.');
  }

  ancestors.add(value);
  try {
    return (
      '[' + value.map((entry) => serialize(entry, ancestors)).join(',') + ']'
    );
  } finally {
    ancestors.delete(value);
  }
}

function serializeObject(value: object, ancestors: WeakSet<object>): string {
  if (!isPlainObject(value)) {
    throw new Error('Request fingerprint payload must contain plain objects.');
  }
  if (ancestors.has(value)) {
    throw new Error('Request fingerprint payload must not be circular.');
  }

  ancestors.add(value);
  try {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => {
          const entry = (value as Readonly<Record<string, unknown>>)[key];
          return JSON.stringify(key) + ':' + serialize(entry, ancestors);
        })
        .join(',') +
      '}'
    );
  } finally {
    ancestors.delete(value);
  }
}

function isPlainObject(
  value: object,
): value is Readonly<Record<string, unknown>> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
