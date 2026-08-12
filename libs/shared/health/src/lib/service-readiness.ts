import type { DatabaseReadinessClient } from '@edu-api/database';
import { isDatabaseReady } from '@edu-api/database';
import type { RedisReadinessClient } from '@edu-api/redis';
import { isRedisReady } from '@edu-api/redis';

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
