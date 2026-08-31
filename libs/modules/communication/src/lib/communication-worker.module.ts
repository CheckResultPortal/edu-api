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
import { createSecretKeyring, type SecretKeyring } from '@edu-api/encryption';
import { StructuredLogger } from '@edu-api/observability';

import { AdminInvitationEmailDeliveryService } from './application/admin-invitation-email-delivery.service';
import { AdminPasswordResetEmailOutboxConsumer } from './application/admin-password-reset-email-outbox-consumer';
import {
  decodeCommunicationKey,
  type AdminInvitationDeliveryConfiguration,
} from './application/admin-invitation-delivery-reader';
import type { EmailProvider } from './application/email-provider';
import type { SmsProvider } from './application/sms-provider';
import { VoucherDeliveryService } from './application/voucher-delivery.service';
import { MoolreSmsProvider } from './infrastructure/moolre-sms-provider';
import { PrismaVoucherDeliverySourceReader } from './infrastructure/prisma-voucher-delivery-source-reader';
import { ResendEmailProvider } from './infrastructure/resend-email-provider';
import { VoucherAllocatedOutboxConsumer } from './infrastructure/voucher-allocated-outbox-consumer';

const ADMIN_INVITATION_EMAIL_PROVIDER = Symbol(
  'ADMIN_INVITATION_EMAIL_PROVIDER',
);
const VOUCHER_EMAIL_PROVIDER = Symbol('VOUCHER_EMAIL_PROVIDER');
const VOUCHER_SMS_PROVIDER = Symbol('VOUCHER_SMS_PROVIDER');

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

@Injectable()
class AdminPasswordResetEmailPoller
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private interval: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(
    private readonly resets: AdminPasswordResetEmailOutboxConsumer,
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
      const processed = await this.resets.processAvailable(
        this.config.getOrThrow<number>('ADMIN_INVITATION_EMAIL_BATCH_SIZE'),
      );
      if (processed !== 0) {
        this.logger.log(
          `Admin password-reset delivery cycle completed: processed=${processed}`,
          'AdminPasswordResetEmailDelivery',
        );
      }
    } catch {
      this.logger.error(
        'Admin password-reset delivery cycle failed; retrying on the next scheduled poll.',
        undefined,
        'AdminPasswordResetEmailDelivery',
      );
    } finally {
      this.isRunning = false;
    }
  }
}

@Injectable()
class VoucherDeliveryPoller
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private interval: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(
    private readonly obligations: VoucherAllocatedOutboxConsumer,
    private readonly deliveries: VoucherDeliveryService,
    private readonly config: ConfigService,
    private readonly logger: StructuredLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.getOrThrow<string>('NODE_ENV') === 'test') return;
    void this.runCycle();
    this.interval = setInterval(
      () => void this.runCycle(),
      this.config.getOrThrow<number>('VOUCHER_DELIVERY_POLL_INTERVAL_MS'),
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
        'VOUCHER_DELIVERY_BATCH_SIZE',
      );
      const obligations = await this.obligations.processAvailable(batchSize);
      const recovered =
        await this.deliveries.recoverStalledDeliveries(batchSize);
      const delivered = await this.deliveries.processAvailable(batchSize);
      if (obligations !== 0 || recovered !== 0 || delivered !== 0) {
        this.logger.log(
          `Voucher delivery cycle completed: obligations=${obligations} recovered=${recovered} delivered=${delivered}`,
          'VoucherDelivery',
        );
      }
    } catch {
      this.logger.error(
        'Voucher delivery cycle failed; retrying on the next scheduled poll.',
        undefined,
        'VoucherDelivery',
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
      provide: VOUCHER_EMAIL_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): EmailProvider =>
        new ResendEmailProvider({
          apiKey: config.getOrThrow<string>('RESEND_API_KEY'),
        }),
    },
    {
      provide: VOUCHER_SMS_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SmsProvider =>
        new MoolreSmsProvider({
          baseUrl: config.getOrThrow<string>('MOOLRE_SMS_BASE_URL'),
          requestTimeoutMs: config.getOrThrow<number>(
            'MOOLRE_SMS_REQUEST_TIMEOUT_MS',
          ),
          senderId: config.getOrThrow<string>('MOOLRE_SMS_SENDER_ID'),
          vasKey: config.getOrThrow<string>('MOOLRE_SMS_VAS_KEY'),
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
        const identity: AdminInvitationDeliveryConfiguration = {
          applicationOrigin: config.getOrThrow<string>(
            'ADMIN_APPLICATION_ORIGIN',
          ),
          hmacKey: decodeCommunicationKey(
            config.getOrThrow<string>('ADMIN_SESSION_HMAC_KEY'),
          ),
          secretEncryptionKeyId: config.getOrThrow<string>(
            'ADMIN_SECRET_ENCRYPTION_KEY_ID',
          ),
          secretEncryptionKey: decodeCommunicationKey(
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
    {
      provide: AdminPasswordResetEmailOutboxConsumer,
      inject: [DATABASE_CLIENT, ConfigService, ADMIN_INVITATION_EMAIL_PROVIDER],
      useFactory: (
        database: DatabaseClient,
        config: ConfigService,
        provider: EmailProvider,
      ) => {
        const identity: AdminInvitationDeliveryConfiguration = {
          applicationOrigin: config.getOrThrow<string>(
            'ADMIN_APPLICATION_ORIGIN',
          ),
          hmacKey: decodeCommunicationKey(
            config.getOrThrow<string>('ADMIN_SESSION_HMAC_KEY'),
          ),
          secretEncryptionKeyId: config.getOrThrow<string>(
            'ADMIN_SECRET_ENCRYPTION_KEY_ID',
          ),
          secretEncryptionKey: decodeCommunicationKey(
            config.getOrThrow<string>('ADMIN_SECRET_ENCRYPTION_KEY'),
          ),
        };
        return new AdminPasswordResetEmailOutboxConsumer(
          database,
          identity,
          provider,
          {
            from: config.getOrThrow<string>('RESEND_FROM_EMAIL'),
            leaseMs: 60_000,
            maximumAutomaticAttempts: config.getOrThrow<number>(
              'ADMIN_INVITATION_EMAIL_MAX_ATTEMPTS',
            ),
            workerId: `${config.getOrThrow<string>('SERVICE_NAME')}:${process.pid}`,
          },
        );
      },
    },
    PrismaVoucherDeliverySourceReader,
    {
      provide: VoucherAllocatedOutboxConsumer,
      inject: [
        DATABASE_CLIENT,
        PrismaVoucherDeliverySourceReader,
        ConfigService,
      ],
      useFactory: (
        database: DatabaseClient,
        sourceReader: PrismaVoucherDeliverySourceReader,
        config: ConfigService,
      ) =>
        new VoucherAllocatedOutboxConsumer(database, sourceReader, {
          leaseMs: config.getOrThrow<number>(
            'VOUCHER_DELIVERY_PROCESSING_LEASE_MS',
          ),
          maxAttempts: config.getOrThrow<number>(
            'VOUCHER_DELIVERY_MAX_ATTEMPTS',
          ),
          maximumRetryDelayMs: config.getOrThrow<number>(
            'VOUCHER_DELIVERY_RETRY_MAX_DELAY_MS',
          ),
          retryBaseDelayMs: config.getOrThrow<number>(
            'VOUCHER_DELIVERY_RETRY_BASE_DELAY_MS',
          ),
          workerId: `${config.getOrThrow<string>('SERVICE_NAME')}:${process.pid}`,
        }),
    },
    {
      provide: VoucherDeliveryService,
      inject: [
        DATABASE_CLIENT,
        VOUCHER_EMAIL_PROVIDER,
        VOUCHER_SMS_PROVIDER,
        ConfigService,
      ],
      useFactory: (
        database: DatabaseClient,
        email: EmailProvider,
        sms: SmsProvider,
        config: ConfigService,
      ) => {
        const keyring: SecretKeyring = createSecretKeyring({
          activeKeyId: config.getOrThrow<string>(
            'VOUCHER_SECRET_ENCRYPTION_KEY_ID',
          ),
          fingerprintKey: decodeCommunicationKey(
            config.getOrThrow<string>('VOUCHER_PIN_FINGERPRINT_KEY'),
          ),
          keys: [
            {
              id: config.getOrThrow<string>('VOUCHER_SECRET_ENCRYPTION_KEY_ID'),
              material: decodeCommunicationKey(
                config.getOrThrow<string>('VOUCHER_SECRET_ENCRYPTION_KEY'),
              ),
            },
          ],
        });
        return new VoucherDeliveryService(database, email, sms, keyring, {
          emailFrom: config.getOrThrow<string>('RESEND_FROM_EMAIL'),
          maximumAutomaticAttempts: config.getOrThrow<number>(
            'VOUCHER_DELIVERY_MAX_ATTEMPTS',
          ),
          maximumRetryDelayMs: config.getOrThrow<number>(
            'VOUCHER_DELIVERY_RETRY_MAX_DELAY_MS',
          ),
          processingLeaseMs: config.getOrThrow<number>(
            'VOUCHER_DELIVERY_PROCESSING_LEASE_MS',
          ),
          retryBaseDelayMs: config.getOrThrow<number>(
            'VOUCHER_DELIVERY_RETRY_BASE_DELAY_MS',
          ),
          supportPhone: config.getOrThrow<string>('CUSTOMER_SUPPORT_PHONE'),
        });
      },
    },
    AdminInvitationEmailDeliveryPoller,
    AdminPasswordResetEmailPoller,
    VoucherDeliveryPoller,
  ],
})
export class CommunicationWorkerModule {}
