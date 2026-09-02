import { createHmac } from 'node:crypto';

import type Redis from 'ioredis';

import { closeRedisClient } from '@edu-api/redis';

import { OrderRateLimitExceededError } from '../application/order-creation-errors';
import type { OrderRateLimiter } from '../application/order-creation-service';

export interface OrderRateLimitConfiguration {
  readonly ipMaximum: number;
  readonly keyPrefix?: string;
  readonly phoneMaximum: number;
  readonly windowMs: number;
}

const consumeCounterScript = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { current, ttl }
`;

export class RedisOrderRateLimiter implements OrderRateLimiter {
  private connection: Promise<unknown> | undefined;

  constructor(
    private readonly client: Redis,
    private readonly configuration: OrderRateLimitConfiguration,
    private readonly privacyHmacKey: Uint8Array,
  ) {
    if (privacyHmacKey.byteLength !== 32) {
      throw new Error('Order rate-limit HMAC key must contain 32 bytes.');
    }
  }

  async consume(input: {
    readonly clientIp?: string;
    readonly phoneNumber: string;
  }): Promise<void> {
    try {
      await this.ensureConnected();
      if (input.clientIp !== undefined) {
        await this.consumeCounter(
          `${this.keyPrefix()}:ip:${safeHash('ip', input.clientIp, this.privacyHmacKey)}`,
          this.configuration.ipMaximum,
        );
      }
      await this.consumeCounter(
        `${this.keyPrefix()}:phone:${safeHash(
          'phone',
          input.phoneNumber,
          this.privacyHmacKey,
        )}`,
        this.configuration.phoneMaximum,
      );
    } catch (error) {
      if (error instanceof OrderRateLimitExceededError) throw error;
      // Redis is transient abuse-control infrastructure. A Redis outage must
      // not invent or lose PostgreSQL order facts; readiness/alerts expose it.
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await closeRedisClient(this.client);
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.status !== 'wait') return;
    this.connection ??= this.client.connect().finally(() => {
      this.connection = undefined;
    });
    await this.connection;
  }

  private async consumeCounter(key: string, maximum: number): Promise<void> {
    const result = await this.client.eval(
      consumeCounterScript,
      1,
      key,
      String(this.configuration.windowMs),
    );
    if (!Array.isArray(result)) throw new Error('Invalid Redis rate response.');
    const count = Number(result[0]);
    const ttlMs = Math.max(1, Number(result[1]));
    if (!Number.isFinite(count) || !Number.isFinite(ttlMs)) {
      throw new Error('Invalid Redis rate response.');
    }
    if (count > maximum) {
      throw new OrderRateLimitExceededError(Math.ceil(ttlMs / 1_000));
    }
  }

  private keyPrefix(): string {
    return this.configuration.keyPrefix ?? 'order-rate';
  }
}

function safeHash(
  context: 'ip' | 'phone',
  value: string,
  hmacKey: Uint8Array,
): string {
  return createHmac('sha256', hmacKey)
    .update(`order-rate-limit:${context}:v1:`, 'utf8')
    .update(value, 'utf8')
    .digest('base64url');
}
