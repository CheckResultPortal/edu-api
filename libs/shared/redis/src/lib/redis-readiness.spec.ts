import { isRedisReady } from './redis-readiness';

describe('isRedisReady', () => {
  it('accepts a Redis PONG response', async () => {
    await expect(
      isRedisReady({ ping: jest.fn().mockResolvedValue('PONG') }),
    ).resolves.toBe(true);
  });

  it('connects a lazy client before pinging it', async () => {
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue('PONG'),
      status: 'wait',
    };

    await expect(isRedisReady(client)).resolves.toBe(true);
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('returns false when Redis rejects the check', async () => {
    await expect(
      isRedisReady({ ping: jest.fn().mockRejectedValue(new Error()) }),
    ).resolves.toBe(false);
  });
});
