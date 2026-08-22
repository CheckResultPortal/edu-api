import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  CatalogCoreModule,
  TRANSACTIONAL_ORDER_PRODUCT_QUERY,
  type TransactionalOrderProductQuery,
} from '@edu-api/catalog';
import {
  DATABASE_CLIENT,
  DatabaseModule,
  type DatabaseClient,
} from '@edu-api/database';
import { createRedisClient } from '@edu-api/redis';

import {
  DefaultOrderCreationService,
  DefaultUssdOrderCreationService,
  ORDER_CREATION_REPOSITORY,
  ORDER_CREATION_SERVICE,
  ORDER_RATE_LIMITER,
  ORDER_USSD_CREATION_SERVICE,
  type OrderCreationRepository,
  type OrderRateLimiter,
} from './application/order-creation-service';
import { PrismaOrderCreationRepository } from './infrastructure/prisma-order-creation.repository';
import { RedisOrderRateLimiter } from './infrastructure/redis-order-rate-limiter';
import { PublicOrdersController } from './presentation/public-orders.controller';

@Module({
  imports: [DatabaseModule, CatalogCoreModule],
  providers: [
    {
      provide: ORDER_CREATION_REPOSITORY,
      inject: [DATABASE_CLIENT, TRANSACTIONAL_ORDER_PRODUCT_QUERY],
      useFactory: (
        database: DatabaseClient,
        catalog: TransactionalOrderProductQuery,
      ): PrismaOrderCreationRepository =>
        new PrismaOrderCreationRepository(database, catalog),
    },
    {
      provide: ORDER_RATE_LIMITER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): RedisOrderRateLimiter =>
        new RedisOrderRateLimiter(
          createRedisClient({ REDIS_URL: config.getOrThrow('REDIS_URL') }),
          {
            ipMaximum: config.getOrThrow('ORDER_RATE_LIMIT_IP_MAXIMUM'),
            phoneMaximum: config.getOrThrow('ORDER_RATE_LIMIT_PHONE_MAXIMUM'),
            windowMs: config.getOrThrow('ORDER_RATE_LIMIT_WINDOW_MS'),
          },
          decodePrivacyHmacKey(config),
        ),
    },
    {
      provide: ORDER_CREATION_SERVICE,
      inject: [ORDER_CREATION_REPOSITORY, ORDER_RATE_LIMITER, ConfigService],
      useFactory: (
        repository: OrderCreationRepository,
        rateLimiter: OrderRateLimiter,
        config: ConfigService,
      ): DefaultOrderCreationService =>
        new DefaultOrderCreationService(
          repository,
          rateLimiter,
          config.getOrThrow('ORDER_IDEMPOTENCY_TTL_MS'),
          decodePrivacyHmacKey(config),
        ),
    },
    {
      provide: ORDER_USSD_CREATION_SERVICE,
      inject: [ORDER_CREATION_REPOSITORY, ORDER_RATE_LIMITER, ConfigService],
      useFactory: (
        repository: OrderCreationRepository,
        rateLimiter: OrderRateLimiter,
        config: ConfigService,
      ): DefaultUssdOrderCreationService =>
        new DefaultUssdOrderCreationService(
          repository,
          rateLimiter,
          config.getOrThrow('ORDER_IDEMPOTENCY_TTL_MS'),
          decodePrivacyHmacKey(config),
        ),
    },
  ],
  exports: [ORDER_CREATION_SERVICE, ORDER_USSD_CREATION_SERVICE],
})
export class OrdersCoreModule {}

@Module({
  imports: [OrdersCoreModule],
  controllers: [PublicOrdersController],
})
export class OrdersModule {}

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
