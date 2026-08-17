import { createHash } from 'node:crypto';

import type Redis from 'ioredis';

import { closeRedisClient } from '@edu-api/redis';

import { OrderRateLimitExceededError } from '../application/order-creation-errors';
import type { OrderRateLimiter } from '../application/order-creation-service';

export interface OrderRateLimitConfiguration {
  readonly ipMaximum: number;
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
  ) {}

  async consume(input: {
    readonly clientIp: string;
    readonly phoneNumber: string;
  }): Promise<void> {
    try {
      await this.ensureConnected();
      await this.consumeCounter(
        `order-rate:ip:${safeHash(input.clientIp)}`,
        this.configuration.ipMaximum,
      );
      await this.consumeCounter(
        `order-rate:phone:${safeHash(input.phoneNumber)}`,
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
}

function safeHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}
