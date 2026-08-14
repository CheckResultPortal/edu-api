import {
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
import {
  decodeBase64UrlKey,
  type AdminIdentityConfiguration,
} from '@edu-api/administration';
import { StructuredLogger } from '@edu-api/observability';

import { AdminInvitationEmailDeliveryService } from './application/admin-invitation-email-delivery.service';
import type { EmailProvider } from './application/email-provider';
import { ResendEmailProvider } from './infrastructure/resend-email-provider';

const ADMIN_INVITATION_EMAIL_PROVIDER = Symbol(
  'ADMIN_INVITATION_EMAIL_PROVIDER',
);

@Injectable()
class AdminInvitationEmailDeliveryPoller
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private interval: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(
    private readonly deliveries: AdminInvitationEmailDeliveryService,
    private readonly config: ConfigService,
    private readonly logger: StructuredLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.getOrThrow<string>('NODE_ENV') === 'test') return;
    void this.runCycle();
    this.interval = setInterval(
      () => void this.runCycle(),
      this.config.getOrThrow<number>('ADMIN_INVITATION_EMAIL_POLL_INTERVAL_MS'),
    );
  }

  onApplicationShutdown(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
  }

  private async runCycle(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const batchSize = this.config.getOrThrow<number>(
        'ADMIN_INVITATION_EMAIL_BATCH_SIZE',
      );
      const recovered =
        await this.deliveries.recoverStalledDeliveries(batchSize);
      const processed = await this.deliveries.processAvailable(batchSize);
      if (recovered !== 0 || processed !== 0) {
        this.logger.log(
          `Admin invitation delivery cycle completed: recovered=${recovered} processed=${processed}`,
          'AdminInvitationEmailDelivery',
        );
      }
    } catch {
      this.logger.error(
        'Admin invitation delivery cycle failed; retrying on the next scheduled poll.',
        undefined,
        'AdminInvitationEmailDelivery',
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
      provide: ADMIN_INVITATION_EMAIL_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): EmailProvider =>
        new ResendEmailProvider({
          apiKey: config.getOrThrow<string>('RESEND_API_KEY'),
        }),
    },
    {
      provide: AdminInvitationEmailDeliveryService,
      inject: [DATABASE_CLIENT, ConfigService, ADMIN_INVITATION_EMAIL_PROVIDER],
      useFactory: (
        database: DatabaseClient,
        config: ConfigService,
        provider: EmailProvider,
      ) => {
        const identity: AdminIdentityConfiguration = {
          applicationOrigin: config.getOrThrow<string>(
            'ADMIN_APPLICATION_ORIGIN',
          ),
          hmacKey: decodeBase64UrlKey(
            config.getOrThrow<string>('ADMIN_SESSION_HMAC_KEY'),
          ),
          secretEncryptionKeyId: config.getOrThrow<string>(
            'ADMIN_SECRET_ENCRYPTION_KEY_ID',
          ),
          secretEncryptionKey: decodeBase64UrlKey(
            config.getOrThrow<string>('ADMIN_SECRET_ENCRYPTION_KEY'),
          ),
        };
        return new AdminInvitationEmailDeliveryService(
          database,
          identity,
          provider,
          {
            from: config.getOrThrow<string>('RESEND_FROM_EMAIL'),
            maximumAutomaticAttempts: config.getOrThrow<number>(
              'ADMIN_INVITATION_EMAIL_MAX_ATTEMPTS',
            ),
            providerName: 'resend',
            workerId: `${config.getOrThrow<string>('SERVICE_NAME')}:${process.pid}`,
          },
        );
      },
    },
    AdminInvitationEmailDeliveryPoller,
  ],
})
export class CommunicationWorkerModule {}
