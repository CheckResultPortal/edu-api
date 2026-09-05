import type { Redis } from 'ioredis';

import type {
  UssdSessionData,
  UssdSessionStore,
} from '../application/ussd-session-store';

export class RedisUssdSessionStore implements UssdSessionStore {
  constructor(private readonly redis: Redis) {}

  async get(msisdn: string): Promise<UssdSessionData | null> {
    const raw = await this.redis.get(sessionKey(msisdn));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isSessionData(parsed)) return null;
    return parsed;
  }

  async set(
    msisdn: string,
    data: UssdSessionData,
    ttlMilliseconds: number,
  ): Promise<void> {
    await this.redis.set(
      sessionKey(msisdn),
      JSON.stringify(data),
      'PX',
      ttlMilliseconds,
    );
  }

  async delete(msisdn: string): Promise<void> {
    await this.redis.del(sessionKey(msisdn));
  }
}

function sessionKey(msisdn: string): string {
  return `ussd:session:${msisdn}`;
}

function isSessionData(value: unknown): value is UssdSessionData {
  if (typeof value !== 'object' || value === null) return false;
  const state = (value as Record<string, unknown>)['state'];
  return (
    state === 'HOME' ||
    state === 'RETRIEVAL_REFERENCE' ||
    state === 'RETRIEVAL_CONFIRM' ||
    state === 'RETRIEVAL_COMPLETE' ||
    state === 'CATEGORY' ||
    state === 'PRODUCT' ||
    state === 'QUANTITY' ||
    state === 'DELIVERY' ||
    state === 'EMAIL' ||
    state === 'CONFIRM' ||
    state === 'PAYMENT_PENDING'
  );
}
