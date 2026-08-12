import type { DatabaseReadinessClient } from '@template/database';
import { isDatabaseReady } from '@template/database';
import type { RedisReadinessClient } from '@template/redis';
import { isRedisReady } from '@template/redis';

export interface ServiceReadinessDependencies {
  readonly database: DatabaseReadinessClient;
  readonly redis: RedisReadinessClient;
}

export interface ServiceReadiness {
  readonly database: boolean;
  readonly ready: boolean;
  readonly redis: boolean;
}

export async function assessServiceReadiness(
  dependencies: ServiceReadinessDependencies,
): Promise<ServiceReadiness> {
  const [database, redis] = await Promise.all([
    isDatabaseReady(dependencies.database),
    isRedisReady(dependencies.redis),
  ]);

  return {
    database,
    ready: database && redis,
    redis,
  };
}
