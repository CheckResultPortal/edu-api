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
  VOUCHER_INVENTORY_SERVICE,
  type VoucherInventoryService,
} from './application/voucher-inventory-service';
import { VoucherInventoryCoreModule } from './voucher-inventory.module';

@Injectable()
class VoucherImportRecoveryPoller
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private interval: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(
    @Inject(VOUCHER_INVENTORY_SERVICE)
    private readonly inventory: VoucherInventoryService,
    private readonly config: ConfigService,
    private readonly logger: StructuredLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.getOrThrow<string>('NODE_ENV') === 'test') return;
    void this.runCycle();
    this.interval = setInterval(
      () => void this.runCycle(),
      this.config.getOrThrow<number>(
        'VOUCHER_IMPORT_RECOVERY_POLL_INTERVAL_MS',
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
      const recovered = await this.inventory.recoverStaleImports(
        this.config.getOrThrow<number>('VOUCHER_IMPORT_CHUNK_SIZE'),
      );
      if (recovered !== 0) {
        this.logger.warn(
          `Voucher import recovery cycle failed ${recovered} stale batch(es).`,
          'VoucherImportRecovery',
        );
      }
    } catch {
      this.logger.error(
        'Voucher import recovery cycle failed; retrying on the next scheduled poll.',
        undefined,
        'VoucherImportRecovery',
      );
    } finally {
      this.isRunning = false;
    }
  }
}

@Module({
  imports: [VoucherInventoryCoreModule],
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
    VoucherImportRecoveryPoller,
  ],
})
export class VoucherInventoryWorkerModule {}
