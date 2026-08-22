import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validatePublicApiEnvironment } from '@edu-api/config';
import { DatabaseModule } from '@edu-api/database';
import { HealthModule } from '@edu-api/health/health.module';
import { CatalogModule } from '@edu-api/catalog';
import { OrdersModule } from '@edu-api/orders';
import { PaymentsModule } from '@edu-api/payments';
import { UssdModule } from '@edu-api/ussd';

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
    OrdersModule,
    PaymentsModule,
    UssdModule,
  ],
})
export class PublicApiModule {}
