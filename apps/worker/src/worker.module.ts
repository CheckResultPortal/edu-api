import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateWorkerEnvironment } from '@edu-api/config';
import { CommunicationWorkerModule } from '@edu-api/communication';
import { FulfilmentWorkerModule } from '@edu-api/fulfilment';
import { OrdersWorkerModule } from '@edu-api/orders';
import { PaymentsWorkerModule } from '@edu-api/payments';
import { StockMonitoringWorkerModule } from '@edu-api/stock-monitoring';
import { ReconciliationWorkerModule } from '@edu-api/reconciliation';
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
    FulfilmentWorkerModule,
    OrdersWorkerModule,
    PaymentsWorkerModule,
    ReconciliationWorkerModule,
    StockMonitoringWorkerModule,
    VoucherInventoryWorkerModule,
  ],
})
export class WorkerModule {}
