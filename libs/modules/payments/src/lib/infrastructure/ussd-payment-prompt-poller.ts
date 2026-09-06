import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { DatabaseWorkSignals } from '@edu-api/database';
import { ConfigService } from '@nestjs/config';
import { StructuredLogger } from '@edu-api/observability';
import { UssdPaymentPromptOutboxConsumer } from './ussd-payment-prompt-outbox-consumer';

@Injectable()
export class UssdPaymentPromptPoller
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private unsubscribe?: () => void;
  private running = false;

  constructor(
    private readonly prompts: UssdPaymentPromptOutboxConsumer,
    private readonly config: ConfigService,
    private readonly logger: StructuredLogger,
    private readonly signals: DatabaseWorkSignals,
  ) {}

  onApplicationBootstrap(): void {
    if (
      this.config.getOrThrow<string>('NODE_ENV') === 'test' ||
      !this.config.getOrThrow<boolean>('USSD_ENABLED')
    )
      return;
    this.unsubscribe = this.signals.watch(['UssdPaymentPromptRequested'], () =>
      this.runCycle(),
    );
  }

  onApplicationShutdown(): void {
    this.unsubscribe?.();
  }

  private async runCycle(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const processed = await this.prompts.processAvailable(
        this.config.getOrThrow<number>('USSD_PAYMENT_PROMPT_BATCH_SIZE'),
      );
      if (processed > 0)
        this.logger.log(
          `USSD prompt cycle processed ${processed} event(s); check payment state for provider outcome.`,
          'UssdPaymentPrompt',
        );
      return (
        processed >=
        this.config.getOrThrow<number>('USSD_PAYMENT_PROMPT_BATCH_SIZE')
      );
    } catch {
      this.logger.error(
        'USSD prompt dispatch cycle failed; recovery will retry.',
        undefined,
        'UssdPaymentPrompt',
      );
      return false;
    } finally {
      this.running = false;
    }
  }
}
