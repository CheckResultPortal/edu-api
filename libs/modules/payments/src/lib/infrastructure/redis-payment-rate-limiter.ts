import { createHmac } from 'node:crypto';

import type Redis from 'ioredis';

import { closeRedisClient } from '@edu-api/redis';

import { PaymentRateLimitExceededError } from '../application/payment-errors';
import type { PaymentRateLimiter } from '../application/payment-initialization-service';

export interface PaymentRateLimitConfiguration {
  readonly ipMaximum: number;
  readonly orderMaximum: number;
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

export class RedisPaymentRateLimiter implements PaymentRateLimiter {
  private connection: Promise<unknown> | undefined;

  constructor(
    private readonly client: Redis,
    private readonly configuration: PaymentRateLimitConfiguration,
    private readonly privacyHmacKey: Uint8Array,
  ) {
    if (privacyHmacKey.byteLength !== 32) {
      throw new Error('Payment rate-limit HMAC key must contain 32 bytes.');
    }
  }

  async consume(input: {
    readonly clientIp: string;
    readonly orderPublicReference: string;
  }): Promise<void> {
    try {
      await this.ensureConnected();
      await this.consumeCounter(
        `payment-rate:ip:${safeHash('ip', input.clientIp, this.privacyHmacKey)}`,
        this.configuration.ipMaximum,
      );
      await this.consumeCounter(
        `payment-rate:order:${safeHash(
          'order',
          input.orderPublicReference,
          this.privacyHmacKey,
        )}`,
        this.configuration.orderMaximum,
      );
    } catch (error) {
      if (error instanceof PaymentRateLimitExceededError) throw error;
      // Redis is a transient abuse control; PostgreSQL remains authoritative.
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
      throw new PaymentRateLimitExceededError(Math.ceil(ttlMs / 1_000));
    }
  }
}

function safeHash(
  context: 'ip' | 'order',
  value: string,
  hmacKey: Uint8Array,
): string {
  return createHmac('sha256', hmacKey)
    .update(`payment-rate-limit:${context}:v1:`, 'utf8')
    .update(value, 'utf8')
    .digest('base64url');
}
