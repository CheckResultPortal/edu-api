import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StructuredLogger } from '@edu-api/observability';
import { UssdPaymentPromptOutboxConsumer } from './ussd-payment-prompt-outbox-consumer';

@Injectable()
export class UssdPaymentPromptPoller
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private interval: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prompts: UssdPaymentPromptOutboxConsumer,
    private readonly config: ConfigService,
    private readonly logger: StructuredLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (
      this.config.getOrThrow<string>('NODE_ENV') === 'test' ||
      !this.config.getOrThrow<boolean>('USSD_ENABLED')
    )
      return;
    void this.runCycle();
    this.interval = setInterval(
      () => void this.runCycle(),
      this.config.getOrThrow<number>('USSD_PAYMENT_PROMPT_POLL_INTERVAL_MS'),
    );
  }

  onApplicationShutdown(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
  }

  private async runCycle(): Promise<void> {
    if (this.running) return;
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
    } catch {
      this.logger.error(
        'USSD prompt dispatch cycle failed; retrying next poll.',
        undefined,
        'UssdPaymentPrompt',
      );
    } finally {
      this.running = false;
    }
  }
}
