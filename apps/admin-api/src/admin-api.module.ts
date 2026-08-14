import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { validateAdminApiEnvironment } from '@edu-api/config';
import {
  DATABASE_CLIENT,
  DatabaseModule,
  type DatabaseReadinessClient,
} from '@edu-api/database';
import { HealthModule } from '@edu-api/health/health.module';
import { AdministrationModule } from '@edu-api/administration';
import {
  SERVICE_DEPENDENCIES,
  createServiceDependencies,
} from '@edu-api/health';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['apps/admin-api/.env.local', 'apps/admin-api/.env', '.env'],
      validate: validateAdminApiEnvironment,
    }),
    DatabaseModule,
    HealthModule,
    AdministrationModule,
  ],
  providers: [
    {
      provide: SERVICE_DEPENDENCIES,
      inject: [DATABASE_CLIENT, ConfigService],
      useFactory: (database: DatabaseReadinessClient, config: ConfigService) =>
        createServiceDependencies({
          database,
          redisUrl: config.getOrThrow<string>('REDIS_URL'),
        }),
    },
  ],
})
export class AdminApiModule {}
