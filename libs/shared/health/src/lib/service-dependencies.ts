import type { DatabaseReadinessClient } from '@edu-api/database';
import { closeRedisClient, createRedisClient } from '@edu-api/redis';

export const SERVICE_DEPENDENCIES = Symbol('SERVICE_DEPENDENCIES');

export interface ServiceDependencies {
  readonly database: DatabaseReadinessClient;
  readonly redis: ReturnType<typeof createRedisClient>;
  close(): Promise<void>;
}

export function createServiceDependencies(input: {
  readonly database: DatabaseReadinessClient;
  readonly redisUrl: string;
}): ServiceDependencies {
  const redis = createRedisClient({ REDIS_URL: input.redisUrl });

  return {
    database: input.database,
    redis,
    async close(): Promise<void> {
      await closeRedisClient(redis);
    },
  };
}
