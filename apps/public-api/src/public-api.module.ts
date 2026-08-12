import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { validatePublicApiEnvironment } from '@edu-api/config';
import { HealthModule } from '@edu-api/health/health.module';
import {
  SERVICE_DEPENDENCIES,
  createServiceDependencies,
} from '@edu-api/health';

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
    HealthModule,
  ],
  providers: [
    {
      provide: SERVICE_DEPENDENCIES,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createServiceDependencies({
          DATABASE_URL: config.getOrThrow<string>('DATABASE_URL'),
          REDIS_URL: config.getOrThrow<string>('REDIS_URL'),
        }),
    },
  ],
})
export class PublicApiModule {}
