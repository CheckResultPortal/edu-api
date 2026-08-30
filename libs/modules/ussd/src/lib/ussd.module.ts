import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  CATALOG_PRODUCT_QUERY,
  CatalogCoreModule,
  type CatalogProductQuery,
} from '@edu-api/catalog';
import { DatabaseModule } from '@edu-api/database';
import { ORDER_USSD_CREATION_SERVICE, OrdersCoreModule } from '@edu-api/orders';
import {
  PaymentInitializationInProgressError,
  PAYMENT_INITIALIZATION_SERVICE,
  PaymentProviderRejectedError,
  PaymentProviderUnknownOutcomeError,
  PaymentsCoreModule,
  PaymentsModule,
  type PaymentInitializationService,
} from '@edu-api/payments';
import { createRedisClient } from '@edu-api/redis';
import { StructuredLogger } from '@edu-api/observability';

import {
  DefaultUssdFlowService,
  USSD_FLOW_SERVICE,
  USSD_ORDER_CREATOR,
  USSD_PAYMENT_INITIALIZER,
  USSD_PRODUCT_QUERY,
  type UssdFlowConfiguration,
  type UssdOrderCreator,
  type UssdProductQuery,
} from './application/ussd-flow-service';
import { USSD_PROVIDER, type UssdProvider } from './application/ussd-provider';
import {
  USSD_SESSION_STORE,
  type UssdSessionStore,
} from './application/ussd-session-store';
import { NaloUssdProvider } from './infrastructure/nalo-ussd-provider';
import {
  NALO_GATEWAY_ACCESS_POLICY,
  NaloGatewayAccessPolicy,
} from './infrastructure/nalo-gateway-access-policy';
import { RedisUssdSessionStore } from './infrastructure/redis-ussd-session-store';
import { NaloUssdController } from './presentation/nalo-ussd.controller';

@Module({
  imports: [DatabaseModule, CatalogCoreModule, OrdersCoreModule],
  providers: [
    {
      provide: USSD_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): UssdProvider =>
        new NaloUssdProvider({
          expectedUserId: config.get<string>('NALO_USER_ID') ?? '',
        }),
    },
    {
      provide: NALO_GATEWAY_ACCESS_POLICY,
      inject: [ConfigService],
      useFactory: (config: ConfigService): NaloGatewayAccessPolicy =>
        new NaloGatewayAccessPolicy({
          enabled: config.getOrThrow<boolean>('USSD_ENABLED'),
          trustedSourceIps: config.get<string>('NALO_TRUSTED_SOURCE_IPS'),
        }),
    },
    {
      provide: USSD_SESSION_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): UssdSessionStore =>
        new RedisUssdSessionStore(
          createRedisClient({ REDIS_URL: config.getOrThrow('REDIS_URL') }),
        ),
    },
    {
      provide: USSD_PRODUCT_QUERY,
      inject: [CATALOG_PRODUCT_QUERY],
      useFactory: (catalog: CatalogProductQuery): UssdProductQuery => ({
        listActiveProducts: async (limit: number) =>
          (await catalog.listActiveProducts({ limit })).items.map((item) => ({
            name: item.name,
            publicId: item.publicId,
            sellingPriceMinor: item.sellingPriceMinor,
          })),
      }),
    },
  ],
  exports: [
    USSD_PROVIDER,
    USSD_SESSION_STORE,
    USSD_PRODUCT_QUERY,
    NALO_GATEWAY_ACCESS_POLICY,
  ],
})
export class UssdCoreModule {}

@Module({
  imports: [UssdCoreModule, PaymentsCoreModule, PaymentsModule],
  controllers: [NaloUssdController],
  providers: [
    {
      provide: USSD_ORDER_CREATOR,
      useExisting: ORDER_USSD_CREATION_SERVICE,
    },
    {
      provide: USSD_PAYMENT_INITIALIZER,
      inject: [PAYMENT_INITIALIZATION_SERVICE],
      useFactory: (payments: PaymentInitializationService) => ({
        initialize: async (command: {
          readonly channel: 'USSD';
          readonly clientIp: string;
          readonly idempotencyKey: string;
          readonly orderPublicReference: string;
          readonly payerPhoneNumber: string;
        }) => {
          try {
            return await payments.initialize(command);
          } catch (error) {
            if (
              error instanceof PaymentProviderUnknownOutcomeError ||
              error instanceof PaymentInitializationInProgressError
            ) {
              return { status: 'UNKNOWN' as const };
            }
            if (error instanceof PaymentProviderRejectedError) {
              return { status: 'FAILED' as const };
            }
            throw error;
          }
        },
      }),
    },
    {
      provide: USSD_FLOW_SERVICE,
      inject: [
        USSD_SESSION_STORE,
        USSD_PRODUCT_QUERY,
        USSD_ORDER_CREATOR,
        USSD_PAYMENT_INITIALIZER,
        ConfigService,
      ],
      useFactory: (
        sessions: UssdSessionStore,
        products: UssdProductQuery,
        orderCreator: UssdOrderCreator,
        paymentInitializer: PaymentInitializationService,
        config: ConfigService,
      ): DefaultUssdFlowService =>
        new DefaultUssdFlowService(
          sessions,
          products,
          orderCreator,
          paymentInitializer,
          {
            maximumProducts: config.getOrThrow<number>('USSD_MAX_PRODUCTS'),
            quantityMaximum: 20,
            sessionTtlMilliseconds: config.getOrThrow<number>(
              'USSD_SESSION_TTL_MS',
            ),
            paymentPendingTtlMilliseconds: config.getOrThrow<number>(
              'USSD_PENDING_PAYMENT_TTL_MS',
            ),
          } satisfies UssdFlowConfiguration,
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
  ],
})
export class UssdModule {}
