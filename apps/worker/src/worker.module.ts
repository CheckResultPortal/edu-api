import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateWorkerEnvironment } from '@edu-api/config';
import { CommunicationWorkerModule } from '@edu-api/communication';
import { OrdersWorkerModule } from '@edu-api/orders';
import { PaymentsWorkerModule } from '@edu-api/payments';
import { VoucherInventoryWorkerModule } from '@edu-api/voucher-inventory';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['apps/worker/.env.local', 'apps/worker/.env', '.env'],
      validate: validateWorkerEnvironment,
    }),
    CommunicationWorkerModule,
    OrdersWorkerModule,
    PaymentsWorkerModule,
    VoucherInventoryWorkerModule,
  ],
})
export class WorkerModule {}
