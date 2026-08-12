import {
  Global,
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { closeDatabaseClient } from './database-lifecycle';
import { createPrismaClient } from './prisma-client.factory';

export const DATABASE_CLIENT = Symbol('DATABASE_CLIENT');

export type DatabaseClient = Awaited<ReturnType<typeof createPrismaClient>>;

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
  ],
  exports: [DATABASE_CLIENT],
})
export class DatabaseModule {}
