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

import { PrismaOrderIdempotencyCleanup } from './infrastructure/prisma-order-idempotency-cleanup';

const ORDER_IDEMPOTENCY_CLEANUP = Symbol('ORDER_IDEMPOTENCY_CLEANUP');

@Injectable()
class OrderIdempotencyCleanupPoller
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private interval: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(
    @Inject(ORDER_IDEMPOTENCY_CLEANUP)
    private readonly cleanup: PrismaOrderIdempotencyCleanup,
    private readonly config: ConfigService,
    private readonly logger: StructuredLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.getOrThrow<string>('NODE_ENV') === 'test') return;
    void this.runCycle();
    this.interval = setInterval(
      () => void this.runCycle(),
      this.config.getOrThrow<number>(
        'ORDER_IDEMPOTENCY_CLEANUP_POLL_INTERVAL_MS',
      ),
    );
  }

  onApplicationShutdown(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
  }

  private async runCycle(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const deleted = await this.cleanup.deleteExpired(
        this.config.getOrThrow<number>('ORDER_IDEMPOTENCY_CLEANUP_BATCH_SIZE'),
      );
      if (deleted !== 0) {
        this.logger.log(
          `Order idempotency cleanup deleted ${deleted} expired record(s).`,
          'OrderIdempotencyCleanup',
        );
      }
    } catch {
      this.logger.error(
        'Order idempotency cleanup failed; retrying on the next scheduled poll.',
        undefined,
        'OrderIdempotencyCleanup',
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
      provide: ORDER_IDEMPOTENCY_CLEANUP,
      inject: [DATABASE_CLIENT],
      useFactory: (database: DatabaseClient) =>
        new PrismaOrderIdempotencyCleanup(database),
    },
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
    OrderIdempotencyCleanupPoller,
  ],
})
export class OrdersWorkerModule {}
