import type Redis from 'ioredis';

import { OrderRateLimitExceededError } from '../application/order-creation-errors';
import { RedisOrderRateLimiter } from './redis-order-rate-limiter';

describe('RedisOrderRateLimiter', () => {
  it('uses privacy-safe keys for both approved counters', async () => {
    const evalMock = jest
      .fn()
      .mockResolvedValueOnce([1, 600_000])
      .mockResolvedValueOnce([1, 600_000]);
    const limiter = new RedisOrderRateLimiter(
      fakeRedis(evalMock),
      configuration,
      privacyHmacKey,
    );

    await expect(
      limiter.consume({
        clientIp: '203.0.113.10',
        phoneNumber: '+233241234567',
      }),
    ).resolves.toBeUndefined();

    expect(evalMock).toHaveBeenCalledTimes(2);
    const serializedCalls = JSON.stringify(evalMock.mock.calls);
    expect(serializedCalls).not.toContain('203.0.113.10');
    expect(serializedCalls).not.toContain('+233241234567');
  });

  it('returns the remaining window when a counter is exceeded', async () => {
    const limiter = new RedisOrderRateLimiter(
      fakeRedis(jest.fn().mockResolvedValue([31, 5_100])),
      configuration,
      privacyHmacKey,
    );

    await expect(
      limiter.consume({
        clientIp: '203.0.113.10',
        phoneNumber: '+233241234567',
      }),
    ).rejects.toEqual(new OrderRateLimitExceededError(6));
  });

  it('uses only the per-phone counter for authenticated gateway traffic', async () => {
    const evalMock = jest.fn().mockResolvedValue([1, 600_000]);
    const limiter = new RedisOrderRateLimiter(
      fakeRedis(evalMock),
      configuration,
      privacyHmacKey,
    );

    await limiter.consume({ phoneNumber: '+233241234567' });

    expect(evalMock).toHaveBeenCalledTimes(1);
  });

  it('fails open when transient Redis infrastructure is unavailable', async () => {
    const limiter = new RedisOrderRateLimiter(
      fakeRedis(jest.fn().mockRejectedValue(new Error('redis unavailable'))),
      configuration,
      privacyHmacKey,
    );

    await expect(
      limiter.consume({
        clientIp: '203.0.113.10',
        phoneNumber: '+233241234567',
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects an invalid privacy HMAC key at startup', () => {
    expect(
      () =>
        new RedisOrderRateLimiter(
          fakeRedis(jest.fn()),
          configuration,
          Buffer.alloc(16),
        ),
    ).toThrow('32 bytes');
  });
});

const configuration = {
  ipMaximum: 30,
  phoneMaximum: 10,
  windowMs: 600_000,
};

const privacyHmacKey = Buffer.alloc(32, 7);

function fakeRedis(evalMock: jest.Mock): Redis {
  return {
    status: 'ready',
    eval: evalMock,
    connect: jest.fn(),
    disconnect: jest.fn(),
    quit: jest.fn(),
  } as unknown as Redis;
}
