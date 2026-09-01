import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  DATABASE_CLIENT,
  DatabaseModule,
  type DatabaseClient,
} from '@edu-api/database';
import {
  FulfilmentCoreModule,
  TRANSACTIONAL_FULFILMENT_UNIT_WRITER,
  type TransactionalFulfilmentUnitWriter,
} from '@edu-api/fulfilment';
import {
  OrdersPaymentQueryModule,
  PAYMENT_ORDER_QUERY,
  type PaymentOrderQuery,
} from '@edu-api/orders';
import { createRedisClient } from '@edu-api/redis';

import {
  DefaultPaymentInitializationService,
  PAYMENT_INITIALIZATION_REPOSITORY,
  PAYMENT_INITIALIZATION_SERVICE,
  PAYMENT_RATE_LIMITER,
  type PaymentInitializationRepository,
  type PaymentRateLimiter,
} from './application/payment-initialization-service';
import { PAYMENT_RECOVERY_REPOSITORY } from './application/payment-recovery-service';
import {
  MOOLRE_PAYMENT_PROVIDER,
  PAYMENT_PROVIDER,
  PAYSTACK_PAYMENT_PROVIDER,
  type PaymentProvider,
} from './application/payment-provider';
import {
  DefaultMoolreVerificationWebhookService,
  MOOLRE_WEBHOOK_SERVICE,
} from './application/moolre-webhook-service';
import {
  DefaultPaymentWebhookService,
  PAYMENT_SUCCESS_REPOSITORY,
  PAYMENT_WEBHOOK_SERVICE,
  type PaymentSuccessRepository,
} from './application/payment-success-service';
import { MoolrePaymentProvider } from './infrastructure/moolre-payment-provider';
import { DisabledMoolrePaymentProvider } from './infrastructure/disabled-moolre-payment-provider';
import { PaystackPaymentProvider } from './infrastructure/paystack-payment-provider';
import { PrismaPaymentInitializationRepository } from './infrastructure/prisma-payment-initialization.repository';
import { PrismaPaymentRecoveryRepository } from './infrastructure/prisma-payment-recovery.repository';
import { PrismaPaymentSuccessRepository } from './infrastructure/prisma-payment-success.repository';
import { RedisPaymentRateLimiter } from './infrastructure/redis-payment-rate-limiter';
import { MoolreWebhookController } from './presentation/moolre-webhook.controller';
import { PaystackWebhookController } from './presentation/paystack-webhook.controller';
import { PublicPaymentsController } from './presentation/public-payments.controller';

@Module({
  imports: [DatabaseModule, OrdersPaymentQueryModule, FulfilmentCoreModule],
  providers: [
    {
      provide: PAYSTACK_PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PaystackPaymentProvider =>
        new PaystackPaymentProvider({
          baseUrl: config.getOrThrow<string>('PAYSTACK_BASE_URL'),
          requestTimeoutMs: config.getOrThrow<number>(
            'PAYSTACK_REQUEST_TIMEOUT_MS',
          ),
          secretKey: config.getOrThrow<string>('PAYSTACK_SECRET_KEY'),
        }),
    },
    {
      provide: MOOLRE_PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService,
      ): MoolrePaymentProvider | DisabledMoolrePaymentProvider => {
        if (!config.getOrThrow<boolean>('USSD_ENABLED')) {
          return new DisabledMoolrePaymentProvider();
        }
        return new MoolrePaymentProvider({
          baseUrl: config.getOrThrow<string>('MOOLRE_BASE_URL'),
          requestTimeoutMs: config.getOrThrow<number>(
            'MOOLRE_REQUEST_TIMEOUT_MS',
          ),
          apiUser: config.getOrThrow<string>('MOOLRE_API_USER'),
          publicKey: config.getOrThrow<string>('MOOLRE_PUBLIC_KEY'),
          accountNumber: config.getOrThrow<string>('MOOLRE_ACCOUNT_NUMBER'),
        });
      },
    },
    {
      provide: PAYMENT_PROVIDER,
      useExisting: PAYSTACK_PAYMENT_PROVIDER,
    },
    {
      provide: PAYMENT_INITIALIZATION_REPOSITORY,
      inject: [DATABASE_CLIENT, PAYMENT_ORDER_QUERY],
      useFactory: (
        database: DatabaseClient,
        orders: PaymentOrderQuery,
      ): PrismaPaymentInitializationRepository =>
        new PrismaPaymentInitializationRepository(database, orders),
    },
    {
      provide: PAYMENT_SUCCESS_REPOSITORY,
      inject: [
        DATABASE_CLIENT,
        PAYMENT_ORDER_QUERY,
        TRANSACTIONAL_FULFILMENT_UNIT_WRITER,
      ],
      useFactory: (
        database: DatabaseClient,
        orders: PaymentOrderQuery,
        fulfilment: TransactionalFulfilmentUnitWriter,
      ): PrismaPaymentSuccessRepository =>
        new PrismaPaymentSuccessRepository(database, orders, fulfilment),
    },
    {
      provide: PAYMENT_RECOVERY_REPOSITORY,
      inject: [DATABASE_CLIENT],
      useFactory: (database: DatabaseClient): PrismaPaymentRecoveryRepository =>
        new PrismaPaymentRecoveryRepository(database),
    },
  ],
  exports: [
    PAYMENT_INITIALIZATION_REPOSITORY,
    PAYMENT_PROVIDER,
    PAYSTACK_PAYMENT_PROVIDER,
    MOOLRE_PAYMENT_PROVIDER,
    PAYMENT_RECOVERY_REPOSITORY,
    PAYMENT_SUCCESS_REPOSITORY,
  ],
})
export class PaymentsCoreModule {}

@Module({
  imports: [PaymentsCoreModule],
  controllers: [
    MoolreWebhookController,
    PaystackWebhookController,
    PublicPaymentsController,
  ],
  providers: [
    {
      provide: PAYMENT_RATE_LIMITER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): RedisPaymentRateLimiter =>
        new RedisPaymentRateLimiter(
          createRedisClient({ REDIS_URL: config.getOrThrow('REDIS_URL') }),
          {
            ipMaximum: config.getOrThrow('PAYMENT_RATE_LIMIT_IP_MAXIMUM'),
            orderMaximum: config.getOrThrow('PAYMENT_RATE_LIMIT_ORDER_MAXIMUM'),
            windowMs: config.getOrThrow('PAYMENT_RATE_LIMIT_WINDOW_MS'),
          },
          decodePrivacyHmacKey(config),
        ),
    },
    {
      provide: PAYMENT_INITIALIZATION_SERVICE,
      inject: [
        PAYMENT_INITIALIZATION_REPOSITORY,
        PAYSTACK_PAYMENT_PROVIDER,
        MOOLRE_PAYMENT_PROVIDER,
        PAYMENT_RATE_LIMITER,
        ConfigService,
      ],
      useFactory: (
        repository: PaymentInitializationRepository,
        paystack: PaymentProvider,
        moolre: PaymentProvider,
        rateLimiter: PaymentRateLimiter,
        config: ConfigService,
      ): DefaultPaymentInitializationService =>
        new DefaultPaymentInitializationService(
          repository,
          { USSD: moolre, WEB: paystack },
          rateLimiter,
          {
            callbackUrl: config.getOrThrow<string>('PAYSTACK_CALLBACK_URL'),
            idempotencyTtlMs: config.getOrThrow<number>(
              'PAYMENT_IDEMPOTENCY_TTL_MS',
            ),
            initialVerificationDelayMs: config.getOrThrow<number>(
              'PAYMENT_INITIAL_VERIFICATION_DELAY_MS',
            ),
            privacyHmacKey: decodePrivacyHmacKey(config),
          },
        ),
    },
    {
      provide: PAYMENT_WEBHOOK_SERVICE,
      inject: [PAYMENT_PROVIDER, PAYMENT_SUCCESS_REPOSITORY],
      useFactory: (
        provider: PaymentProvider,
        repository: PaymentSuccessRepository,
      ): DefaultPaymentWebhookService =>
        new DefaultPaymentWebhookService(provider, repository),
    },
    {
      provide: MOOLRE_WEBHOOK_SERVICE,
      inject: [MOOLRE_PAYMENT_PROVIDER, PAYMENT_SUCCESS_REPOSITORY],
      useFactory: (
        provider: PaymentProvider,
        repository: PaymentSuccessRepository,
      ): DefaultMoolreVerificationWebhookService =>
        new DefaultMoolreVerificationWebhookService(provider, repository),
    },
  ],
  exports: [PAYMENT_INITIALIZATION_SERVICE],
})
export class PaymentsModule {}

function decodePrivacyHmacKey(config: ConfigService): Uint8Array {
  const key = Buffer.from(
    config.getOrThrow<string>('ORDER_PRIVACY_HMAC_KEY'),
    'base64url',
  );
  if (key.byteLength !== 32) {
    throw new Error('ORDER_PRIVACY_HMAC_KEY must contain 32 bytes.');
  }
  return key;
}
