import type { DatabaseReadinessClient } from '@template/database';
import { closeDatabaseClient, createPrismaClient } from '@template/database';
import { closeRedisClient, createRedisClient } from '@template/redis';

export const SERVICE_DEPENDENCIES = Symbol('SERVICE_DEPENDENCIES');

export interface ServiceDependencies {
  readonly database: DatabaseReadinessClient;
  readonly redis: ReturnType<typeof createRedisClient>;
  close(): Promise<void>;
}

export async function createServiceDependencies(
  environment: Readonly<Record<'DATABASE_URL' | 'REDIS_URL', string>>,
): Promise<ServiceDependencies> {
  const database = await createPrismaClient(environment);
  const redis = createRedisClient(environment);

  return {
    database,
    redis,
    async close(): Promise<void> {
      try {
        await closeRedisClient(redis);
      } finally {
        await closeDatabaseClient(database);
      }
    },
  };
}
