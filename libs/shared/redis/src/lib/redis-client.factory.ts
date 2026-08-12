import Redis from 'ioredis';

export function createRedisClient(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Redis {
  const redisUrl = environment.REDIS_URL;

  if (!redisUrl) {
    throw new Error('REDIS_URL must be configured.');
  }

  return new Redis(redisUrl, {
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
}
