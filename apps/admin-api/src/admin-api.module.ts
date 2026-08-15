import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateAdminApiEnvironment } from '@edu-api/config';
import { DatabaseModule } from '@edu-api/database';
import { HealthModule } from '@edu-api/health/health.module';
import { AdministrationModule } from '@edu-api/administration';

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
})
export class AdminApiModule {}
