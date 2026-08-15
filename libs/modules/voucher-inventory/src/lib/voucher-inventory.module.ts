import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  DATABASE_CLIENT,
  DatabaseModule,
  type DatabaseClient,
} from '@edu-api/database';

import {
  createVoucherInventoryKeyring,
  type VoucherInventoryConfiguration,
} from './application/voucher-inventory-configuration';
import { VOUCHER_INVENTORY_SERVICE } from './application/voucher-inventory-service';
import { PrismaVoucherInventoryService } from './infrastructure/prisma-voucher-inventory.service';

@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: VOUCHER_INVENTORY_SERVICE,
      inject: [DATABASE_CLIENT, ConfigService],
      useFactory: (
        database: DatabaseClient,
        config: ConfigService,
      ): PrismaVoucherInventoryService => {
        const configuration: VoucherInventoryConfiguration = {
          importChunkSize: config.getOrThrow<number>(
            'VOUCHER_IMPORT_CHUNK_SIZE',
          ),
          importMaxBytes: config.getOrThrow<number>('VOUCHER_IMPORT_MAX_BYTES'),
          importStaleAfterMs: config.getOrThrow<number>(
            'VOUCHER_IMPORT_STALE_AFTER_MS',
          ),
          pinFingerprintKey: config.getOrThrow<string>(
            'VOUCHER_PIN_FINGERPRINT_KEY',
          ),
          secretEncryptionKey: config.getOrThrow<string>(
            'VOUCHER_SECRET_ENCRYPTION_KEY',
          ),
          secretEncryptionKeyId: config.getOrThrow<string>(
            'VOUCHER_SECRET_ENCRYPTION_KEY_ID',
          ),
        };
        return new PrismaVoucherInventoryService(
          database,
          createVoucherInventoryKeyring(configuration),
          configuration.importStaleAfterMs,
        );
      },
    },
  ],
  exports: [VOUCHER_INVENTORY_SERVICE],
})
export class VoucherInventoryCoreModule {}
