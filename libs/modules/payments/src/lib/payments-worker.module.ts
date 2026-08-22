import {
  Inject,
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { StructuredLogger } from '@edu-api/observability';

import {
  DefaultPaymentRecoveryService,
  PAYMENT_RECOVERY_REPOSITORY,
  PAYMENT_RECOVERY_SERVICE,
  type PaymentRecoveryRepository,
  type PaymentRecoveryService,
} from './application/payment-recovery-service';
import {
  MOOLRE_PAYMENT_PROVIDER,
  PAYSTACK_PAYMENT_PROVIDER,
  type PaymentProvider,
} from './application/payment-provider';
import {
  PAYMENT_SUCCESS_REPOSITORY,
  type PaymentSuccessRepository,
} from './application/payment-success-service';
import { PaymentsCoreModule } from './payments.module';

@Injectable()
class PaymentRecoveryPoller
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private interval: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(
    @Inject(PAYMENT_RECOVERY_SERVICE)
    private readonly recovery: PaymentRecoveryService,
    private readonly config: ConfigService,
    private readonly logger: StructuredLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.getOrThrow<string>('NODE_ENV') === 'test') return;
    void this.runCycle();
    this.interval = setInterval(
      () => void this.runCycle(),
      this.config.getOrThrow<number>('PAYMENT_RECOVERY_POLL_INTERVAL_MS'),
    );
  }

  onApplicationShutdown(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
  }

  private async runCycle(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const result = await this.recovery.runCycle();
      if (
        result.applied !== 0 ||
        result.needsAttention !== 0 ||
        result.cleanedIdempotencyRecords !== 0
      ) {
        this.logger.log(
          `Payment recovery claimed ${result.claimed}, applied ${result.applied}, needs-attention ${result.needsAttention}, cleaned-idempotency ${result.cleanedIdempotencyRecords}.`,
          'PaymentRecovery',
        );
      }
    } catch {
      this.logger.error(
        'Payment recovery cycle failed; retrying on the next scheduled poll.',
        undefined,
        'PaymentRecovery',
      );
    } finally {
      this.isRunning = false;
    }
  }
}

@Module({
  imports: [PaymentsCoreModule],
  providers: [
    {
      provide: PAYMENT_RECOVERY_SERVICE,
      inject: [
        PAYSTACK_PAYMENT_PROVIDER,
        MOOLRE_PAYMENT_PROVIDER,
        PAYMENT_SUCCESS_REPOSITORY,
        PAYMENT_RECOVERY_REPOSITORY,
        ConfigService,
      ],
      useFactory: (
        paystack: PaymentProvider,
        moolre: PaymentProvider,
        successRepository: PaymentSuccessRepository,
        recoveryRepository: PaymentRecoveryRepository,
        config: ConfigService,
      ): DefaultPaymentRecoveryService =>
        new DefaultPaymentRecoveryService(
          [paystack, moolre],
          successRepository,
          recoveryRepository,
          {
            baseDelayMs: config.getOrThrow<number>(
              'PAYMENT_VERIFICATION_BASE_DELAY_MS',
            ),
            batchSize: config.getOrThrow<number>(
              'PAYMENT_VERIFICATION_BATCH_SIZE',
            ),
            idempotencyCleanupBatchSize: config.getOrThrow<number>(
              'PAYMENT_IDEMPOTENCY_CLEANUP_BATCH_SIZE',
            ),
            leaseMs: config.getOrThrow<number>('PAYMENT_VERIFICATION_LEASE_MS'),
            maxAttempts: config.getOrThrow<number>(
              'PAYMENT_VERIFICATION_MAX_ATTEMPTS',
            ),
          },
        ),
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
    PaymentRecoveryPoller,
  ],
})
export class PaymentsWorkerModule {}
