import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { validatePublicApiEnvironment } from '@edu-api/config';
import {
  DATABASE_CLIENT,
  DatabaseModule,
  type DatabaseReadinessClient,
} from '@edu-api/database';
import { HealthModule } from '@edu-api/health/health.module';
import {
  SERVICE_DEPENDENCIES,
  createServiceDependencies,
} from '@edu-api/health';
import { CatalogModule } from '@edu-api/catalog';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: [
        'apps/public-api/.env.local',
        'apps/public-api/.env',
        '.env',
      ],
      validate: validatePublicApiEnvironment,
    }),
    DatabaseModule,
    HealthModule,
    CatalogModule,
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
export class PublicApiModule {}
