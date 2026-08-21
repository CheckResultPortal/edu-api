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

import { VoucherAllocationProcessingModule } from './fulfilment.module';
import {
  VOUCHER_ALLOCATION_SERVICE,
  type VoucherAllocationService,
} from './application/voucher-allocation-service';
import { PaymentSucceededOutboxConsumer } from './infrastructure/payment-succeeded-outbox-consumer';
import { VoucherStockAddedOutboxConsumer } from './infrastructure/voucher-stock-added-outbox-consumer';

@Injectable()
class VoucherAllocationPoller
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private interval: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(
    private readonly outboxConsumer: PaymentSucceededOutboxConsumer,
    private readonly stockAddedConsumer: VoucherStockAddedOutboxConsumer,
    @Inject(VOUCHER_ALLOCATION_SERVICE)
    private readonly allocationService: VoucherAllocationService,
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    private readonly config: ConfigService,
    private readonly logger: StructuredLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    void this.runCycle();
    const allocationPollInterval = this.config.get<number>(
      'VOUCHER_ALLOCATION_POLL_INTERVAL_MS',
      5_000,
    );
    const restockPollInterval = this.config.get<number>(
      'RESTOCK_DRAIN_POLL_INTERVAL_MS',
      5_000,
    );
    this.interval = setInterval(
      () => void this.runCycle(),
      Math.min(allocationPollInterval, restockPollInterval),
    );
  }

  onApplicationShutdown(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
  }

  private async runCycle(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const batchSize = this.config.get<number>(
        'VOUCHER_ALLOCATION_OUTBOX_BATCH_SIZE',
        10,
      );
      const consumedEvents =
        await this.outboxConsumer.processAvailable(batchSize);
      const consumedStockEvents =
        await this.stockAddedConsumer.processAvailable(
          this.config.get<number>('RESTOCK_DRAIN_OUTBOX_BATCH_SIZE', 10),
        );
      const recovered = await this.recoverWaitingBacklog();
      if (
        consumedEvents !== 0 ||
        consumedStockEvents !== 0 ||
        recovered.allocated !== 0
      ) {
        this.logger.log(
          `Voucher allocation processed ${consumedEvents} payment events, ${consumedStockEvents} stock events, and allocated ${recovered.allocated} voucher(s) across ${recovered.products} recovery product(s).`,
          'VoucherAllocation',
        );
      }
    } catch (error) {
      this.logger.error(
        `Voucher allocation cycle failed (failure=${safeFailureKind(error)}); retrying on next interval.`,
        undefined,
        'VoucherAllocation',
      );
    } finally {
      this.isRunning = false;
    }
  }

  private async recoverWaitingBacklog(): Promise<{
    readonly allocated: number;
    readonly products: number;
  }> {
    const maximumProducts = this.config.get<number>(
      'RESTOCK_DRAIN_RECOVERY_PRODUCT_BATCH_SIZE',
      10,
    );
    const chunkSize = this.config.get<number>('RESTOCK_DRAIN_CHUNK_SIZE', 250);
    let allocated = 0;
    let products = 0;

    for (
      let productIndex = 0;
      productIndex < maximumProducts;
      productIndex += 1
    ) {
      const result = await this.database.$transaction(
        (transaction) =>
          this.allocationService.drainNextWaitingProduct(
            transaction,
            chunkSize,
          ),
        { maxWait: 5_000, timeout: 30_000 },
      );
      if (result.outcome !== 'DRAINED') break;
      products += 1;
      allocated += result.allocation.allocatedCount;
    }

    return { allocated, products };
  }
}

@Module({
  imports: [DatabaseModule, VoucherAllocationProcessingModule],
  providers: [
    {
      provide: StructuredLogger,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new StructuredLogger({
          environment: config.get<string>('NODE_ENV', 'development'),
          level: config.get<
            'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose'
          >('LOG_LEVEL', 'log'),
          service: config.get<string>('SERVICE_NAME', 'worker'),
        }),
    },
    VoucherAllocationPoller,
  ],
  exports: [VoucherAllocationProcessingModule],
})
export class FulfilmentWorkerModule {}

function safeFailureKind(error: unknown): string {
  if (
    error instanceof Error &&
    error.name === 'PrismaClientKnownRequestError'
  ) {
    return 'DATABASE';
  }
  if (error instanceof Error && error.name === 'PrismaClientRustPanicError') {
    return 'DATABASE_RUNTIME';
  }
  return 'UNCLASSIFIED';
}
