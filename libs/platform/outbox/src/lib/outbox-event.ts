export type OutboxPayload =
  | null
  | boolean
  | number
  | string
  | readonly OutboxPayload[]
  | { readonly [key: string]: OutboxPayload };

export interface NewOutboxEvent {
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly dedupeKey?: string;
  readonly eventType: string;
  readonly payload: OutboxPayload;
}

const forbiddenPayloadKeyFragments = [
  'apikey',
  'authorization',
  'credential',
  'password',
  'pin',
  'secret',
  'token',
  'webhooksignature',
] as const;

export function assertValidOutboxEvent(event: NewOutboxEvent): void {
  if (!/^[1-9]\d*$/.test(event.aggregateId)) {
    throw new Error('Outbox aggregateId must be a positive decimal string.');
  }

  assertNonEmpty('aggregateType', event.aggregateType);
  assertNonEmpty('eventType', event.eventType);

  if (event.dedupeKey !== undefined) {
    assertNonEmpty('dedupeKey', event.dedupeKey);
  }

  assertSafePayload(event.payload, new WeakSet<object>());
}

function assertNonEmpty(field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error('Outbox ' + field + ' must not be empty.');
  }
}

function assertSafePayload(
  value: OutboxPayload,
  ancestors: WeakSet<object>,
): void {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Outbox payload numbers must be finite.');
    }
    return;
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error('Outbox payload must not contain circular references.');
    }
    ancestors.add(value);
    try {
      for (const entry of value) {
        assertSafePayload(entry, ancestors);
      }
    } finally {
      ancestors.delete(value);
    }
    return;
  }

  if (ancestors.has(value)) {
    throw new Error('Outbox payload must not contain circular references.');
  }

  ancestors.add(value);
  try {
    for (const [key, entry] of Object.entries(value)) {
      if (isForbiddenPayloadKey(key)) {
        throw new Error('Outbox payload must not contain ' + key + '.');
      }
      assertSafePayload(entry, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function isForbiddenPayloadKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return forbiddenPayloadKeyFragments.some((fragment) =>
    normalized.includes(fragment),
  );
}
