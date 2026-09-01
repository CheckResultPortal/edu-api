import {
  Inject,
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  DATABASE_CLIENT,
  DatabaseModule,
  type DatabaseClient,
} from '@edu-api/database';
import { StructuredLogger } from '@edu-api/observability';

import {
  RECONCILIATION_SERVICE,
  type ReconciliationService,
} from './application/reconciliation-service';
import { PrismaReconciliationService } from './infrastructure/prisma-reconciliation.service';

@Injectable()
class ReconciliationPoller
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private interval: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(RECONCILIATION_SERVICE)
    private readonly reconciliation: ReconciliationService,
    private readonly config: ConfigService,
    private readonly logger: StructuredLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.getOrThrow<string>('NODE_ENV') === 'test') return;
    void this.runCycle();
    this.interval = setInterval(
      () => void this.runCycle(),
      this.config.getOrThrow<number>('RECONCILIATION_POLL_INTERVAL_MS'),
    );
  }

  onApplicationShutdown(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
  }

  private async runCycle(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.reconciliation.process(
        this.config.getOrThrow<number>('RECONCILIATION_BATCH_SIZE'),
      );
      if (result.detected !== 0 || result.resolved !== 0) {
        this.logger.warn(
          `Reconciliation cycle completed: detected=${result.detected} resolved=${result.resolved}.`,
          'Reconciliation',
        );
      }
    } catch {
      this.logger.error(
        'Reconciliation cycle failed; retrying on the next scheduled poll.',
        undefined,
        'Reconciliation',
      );
    } finally {
      this.running = false;
    }
  }
}

@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: RECONCILIATION_SERVICE,
      inject: [DATABASE_CLIENT],
      useFactory: (database: DatabaseClient) =>
        new PrismaReconciliationService(database),
    },
  ],
  exports: [RECONCILIATION_SERVICE],
})
export class ReconciliationCoreModule {}

@Module({
  imports: [ReconciliationCoreModule],
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
    ReconciliationPoller,
  ],
})
export class ReconciliationWorkerModule {}
