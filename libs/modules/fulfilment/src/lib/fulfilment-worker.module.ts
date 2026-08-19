import {
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { StructuredLogger } from '@edu-api/observability';

import { VoucherAllocationProcessingModule } from './fulfilment.module';
import { PaymentSucceededOutboxConsumer } from './infrastructure/payment-succeeded-outbox-consumer';

@Injectable()
class VoucherAllocationPoller
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private interval: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(
    private readonly outboxConsumer: PaymentSucceededOutboxConsumer,
    private readonly config: ConfigService,
    private readonly logger: StructuredLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    void this.runCycle();
    const pollInterval = this.config.get<number>(
      'VOUCHER_ALLOCATION_POLL_INTERVAL_MS',
      5_000,
    );
    this.interval = setInterval(() => void this.runCycle(), pollInterval);
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
      if (consumedEvents !== 0) {
        this.logger.log(
          `PaymentSucceeded outbox consumer processed ${consumedEvents} payment events.`,
          'VoucherAllocation',
        );
      }
    } catch {
      this.logger.error(
        'Voucher allocation cycle failed; retrying on next interval.',
        undefined,
        'VoucherAllocation',
      );
    } finally {
      this.isRunning = false;
    }
  }
}

@Module({
  imports: [VoucherAllocationProcessingModule],
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
