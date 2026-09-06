import {
  Global,
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { StructuredLogger } from '@edu-api/observability';
import { DatabaseWorkSignals } from './database-work-signals';

import { closeDatabaseClient } from './database-lifecycle';
import { createPrismaClient } from './prisma-client.factory';

import type { PrismaClient } from '../../../../../generated/prisma/client';

export const DATABASE_CLIENT = Symbol('DATABASE_CLIENT');

export type DatabaseClient = PrismaClient;

@Injectable()
class DatabaseClientLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly client: DatabaseClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await closeDatabaseClient(this.client);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Promise<DatabaseClient> =>
        createPrismaClient({
          DATABASE_URL: config.getOrThrow<string>('DATABASE_URL'),
        }),
    },
    DatabaseClientLifecycle,
    {
      provide: DatabaseWorkSignals,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new StructuredLogger({
          environment: config.get<string>('NODE_ENV', 'production'),
          service: config.get<string>('SERVICE_NAME', 'worker'),
          level: 'log',
        });
        return new DatabaseWorkSignals(
          () =>
            new Client({
              connectionString: config.getOrThrow<string>('DATABASE_URL'),
              application_name: 'edu-worker-listener',
              connectionTimeoutMillis: 5000,
              query_timeout: 5000,
              keepAlive: true,
            }),
          config.get<number>('WORKER_RECOVERY_INTERVAL_MS', 5000),
          () =>
            logger.warn(
              'Worker notification connection or task failed; durable recovery remains active.',
              'WorkerNotifications',
            ),
        );
      },
    },
  ],
  exports: [DATABASE_CLIENT, DatabaseWorkSignals],
})
export class DatabaseModule {}
