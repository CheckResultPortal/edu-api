import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  DATABASE_CLIENT,
  DatabaseModule,
  type DatabaseClient,
} from '@edu-api/database';
import {
  TRANSACTIONAL_VOUCHER_CLAIMER,
  VoucherAllocationInventoryModule,
  type TransactionalVoucherClaimer,
} from '@edu-api/voucher-inventory';

import { TRANSACTIONAL_FULFILMENT_UNIT_WRITER } from './application/transactional-fulfilment-unit-writer';
import {
  DefaultVoucherAllocationService,
  VOUCHER_ALLOCATION_REPOSITORY,
  VOUCHER_ALLOCATION_SERVICE,
  type VoucherAllocationRepository,
  type VoucherAllocationService,
} from './application/voucher-allocation-service';
import { PaymentSucceededAllocationHandler } from './infrastructure/payment-succeeded-allocation.handler';
import { PaymentSucceededOutboxConsumer } from './infrastructure/payment-succeeded-outbox-consumer';
import { PrismaTransactionalFulfilmentUnitWriter } from './infrastructure/prisma-transactional-fulfilment-unit-writer';
import { PrismaVoucherAllocationRepository } from './infrastructure/prisma-voucher-allocation.repository';

@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: TRANSACTIONAL_FULFILMENT_UNIT_WRITER,
      useClass: PrismaTransactionalFulfilmentUnitWriter,
    },
  ],
  exports: [TRANSACTIONAL_FULFILMENT_UNIT_WRITER],
})
export class FulfilmentCoreModule {}

@Module({
  imports: [DatabaseModule, VoucherAllocationInventoryModule],
  providers: [
    {
      provide: VOUCHER_ALLOCATION_REPOSITORY,
      inject: [TRANSACTIONAL_VOUCHER_CLAIMER],
      useFactory: (
        voucherClaimer: TransactionalVoucherClaimer,
      ): PrismaVoucherAllocationRepository =>
        new PrismaVoucherAllocationRepository(voucherClaimer),
    },
    {
      provide: VOUCHER_ALLOCATION_SERVICE,
      inject: [VOUCHER_ALLOCATION_REPOSITORY],
      useFactory: (
        repository: VoucherAllocationRepository,
      ): DefaultVoucherAllocationService =>
        new DefaultVoucherAllocationService(repository),
    },
    {
      provide: PaymentSucceededAllocationHandler,
      inject: [VOUCHER_ALLOCATION_SERVICE],
      useFactory: (
        service: VoucherAllocationService,
      ): PaymentSucceededAllocationHandler =>
        new PaymentSucceededAllocationHandler(service),
    },
    {
      provide: PaymentSucceededOutboxConsumer,
      inject: [
        DATABASE_CLIENT,
        PaymentSucceededAllocationHandler,
        ConfigService,
      ],
      useFactory: (
        database: DatabaseClient,
        handler: PaymentSucceededAllocationHandler,
        config: ConfigService,
      ): PaymentSucceededOutboxConsumer =>
        new PaymentSucceededOutboxConsumer(database, handler, {
          leaseMs: config.getOrThrow<number>('VOUCHER_ALLOCATION_LEASE_MS'),
          maxAttempts: config.getOrThrow<number>(
            'VOUCHER_ALLOCATION_MAX_ATTEMPTS',
          ),
          maximumRetryDelayMs: config.getOrThrow<number>(
            'VOUCHER_ALLOCATION_RETRY_MAX_DELAY_MS',
          ),
          retryBaseDelayMs: config.getOrThrow<number>(
            'VOUCHER_ALLOCATION_RETRY_BASE_DELAY_MS',
          ),
          workerId: `${config.get<string>('SERVICE_NAME', 'worker')}:${process.pid}`,
        }),
    },
  ],
  exports: [
    VOUCHER_ALLOCATION_REPOSITORY,
    VOUCHER_ALLOCATION_SERVICE,
    PaymentSucceededAllocationHandler,
    PaymentSucceededOutboxConsumer,
  ],
})
export class VoucherAllocationProcessingModule {}

@Module({
  imports: [FulfilmentCoreModule],
  exports: [FulfilmentCoreModule],
})
export class FulfilmentModule {}
