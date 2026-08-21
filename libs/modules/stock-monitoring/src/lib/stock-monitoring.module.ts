import { Inject, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  DATABASE_CLIENT,
  DatabaseModule,
  type DatabaseClient,
} from '@edu-api/database';
import { StructuredLogger } from '@edu-api/observability';

import {
  STOCK_MONITORING_SERVICE,
  type StockMonitoringService,
} from './application/stock-monitoring-service';
import { PrismaStockMonitoringService } from './infrastructure/prisma-stock-monitoring.service';
import { StockAlertOutboxConsumer } from './infrastructure/stock-alert-outbox-consumer';

@Injectable()
class StockMonitoringPoller {
  private interval: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(
    @Inject(STOCK_MONITORING_SERVICE)
    private readonly monitoring: StockMonitoringService,
    private readonly alerts: StockAlertOutboxConsumer,
    private readonly config: ConfigService,
    private readonly logger: StructuredLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.getOrThrow<string>('NODE_ENV') === 'test') return;
    void this.runCycle();
    this.interval = setInterval(
      () => void this.runCycle(),
      this.config.getOrThrow<number>('STOCK_MONITORING_POLL_INTERVAL_MS'),
    );
  }

  onApplicationShutdown(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
  }

  private async runCycle(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const monitoring = await this.monitoring.processAvailable(
        this.config.getOrThrow<number>('STOCK_MONITORING_PRODUCT_BATCH_SIZE'),
      );
      const published = await this.alerts.processAvailable(
        this.config.getOrThrow<number>('STOCK_ALERT_OUTBOX_BATCH_SIZE'),
      );
      if (
        monitoring.evaluatedProducts !== 0 ||
        monitoring.raisedAlerts !== 0 ||
        published !== 0
      ) {
        this.logger.log(
          `Stock monitoring cycle completed: evaluated=${monitoring.evaluatedProducts} raised=${monitoring.raisedAlerts} published=${published} passCompleted=${monitoring.passCompleted}.`,
          'StockMonitoring',
        );
      }
    } catch {
      this.logger.error(
        'Stock monitoring cycle failed; retrying on the next scheduled poll.',
        undefined,
        'StockMonitoring',
      );
    } finally {
      this.isRunning = false;
    }
  }
}

@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: PrismaStockMonitoringService,
      inject: [DATABASE_CLIENT],
      useFactory: (database: DatabaseClient) =>
        new PrismaStockMonitoringService(database),
    },
    {
      provide: STOCK_MONITORING_SERVICE,
      useExisting: PrismaStockMonitoringService,
    },
  ],
  exports: [STOCK_MONITORING_SERVICE],
})
export class StockMonitoringCoreModule {}

@Module({
  imports: [StockMonitoringCoreModule],
  providers: [
    {
      provide: StructuredLogger,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new StructuredLogger({
          environment: config.getOrThrow<string>('NODE_ENV'),
          level: config.getOrThrow<
            'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose'
          >('LOG_LEVEL'),
          service: config.getOrThrow<string>('SERVICE_NAME'),
        }),
    },
    {
      provide: StockAlertOutboxConsumer,
      inject: [DATABASE_CLIENT, StructuredLogger, ConfigService],
      useFactory: (
        database: DatabaseClient,
        logger: StructuredLogger,
        config: ConfigService,
      ) =>
        new StockAlertOutboxConsumer(database, logger, {
          leaseMs: config.getOrThrow<number>('STOCK_ALERT_OUTBOX_LEASE_MS'),
          workerId: `${config.getOrThrow<string>('SERVICE_NAME')}:${process.pid}`,
        }),
    },
    StockMonitoringPoller,
  ],
})
export class StockMonitoringWorkerModule {}
