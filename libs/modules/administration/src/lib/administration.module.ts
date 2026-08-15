import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  DATABASE_CLIENT,
  DatabaseModule,
  type DatabaseClient,
} from '@edu-api/database';
import {
  CATALOG_ADMIN_SERVICE,
  CATALOG_PRODUCT_REFERENCE_QUERY,
  CatalogCoreModule,
  type CatalogAdminService,
  type CatalogProductReferenceQuery,
} from '@edu-api/catalog';
import {
  VoucherInventoryCoreModule,
  type VoucherInventoryService,
  VOUCHER_INVENTORY_SERVICE,
} from '@edu-api/voucher-inventory';

import {
  ADMIN_CATALOG_OPERATIONS_SERVICE,
  PrismaAdminCatalogOperationsService,
} from './application/admin-catalog-operations';
import {
  ADMIN_VOUCHER_INVENTORY_OPERATIONS_SERVICE,
  PrismaAdminVoucherInventoryOperationsService,
} from './application/admin-voucher-inventory-operations';
import { decodeBase64UrlKey } from './application/admin-identity-configuration';
import { ADMIN_IDENTITY_SERVICE } from './application/admin-identity-ports';
import { PrismaAdminIdentityService } from './application/prisma-admin-identity.service';
import { AdminIdentityController } from './presentation/admin-identity.controller';
import { AdminCatalogController } from './presentation/admin-catalog.controller';
import { AdminVoucherInventoryController } from './presentation/admin-voucher-inventory.controller';
import { AdminSessionGuard } from './presentation/admin-session.guard';

@Module({
  imports: [DatabaseModule, CatalogCoreModule, VoucherInventoryCoreModule],
  controllers: [
    AdminIdentityController,
    AdminCatalogController,
    AdminVoucherInventoryController,
  ],
  providers: [
    {
      provide: ADMIN_IDENTITY_SERVICE,
      inject: [DATABASE_CLIENT, ConfigService],
      useFactory: (
        database: DatabaseClient,
        config: ConfigService,
      ): PrismaAdminIdentityService =>
        new PrismaAdminIdentityService(database, {
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
        }),
    },
    {
      provide: ADMIN_CATALOG_OPERATIONS_SERVICE,
      inject: [DATABASE_CLIENT, CATALOG_ADMIN_SERVICE],
      useFactory: (
        database: DatabaseClient,
        catalog: CatalogAdminService,
      ): PrismaAdminCatalogOperationsService =>
        new PrismaAdminCatalogOperationsService(database, catalog),
    },
    {
      provide: ADMIN_VOUCHER_INVENTORY_OPERATIONS_SERVICE,
      inject: [
        DATABASE_CLIENT,
        CATALOG_PRODUCT_REFERENCE_QUERY,
        VOUCHER_INVENTORY_SERVICE,
        ConfigService,
      ],
      useFactory: (
        database: DatabaseClient,
        catalog: CatalogProductReferenceQuery,
        inventory: VoucherInventoryService,
        config: ConfigService,
      ): PrismaAdminVoucherInventoryOperationsService =>
        new PrismaAdminVoucherInventoryOperationsService(
          database,
          catalog,
          inventory,
          config,
        ),
    },
    AdminSessionGuard,
  ],
  exports: [
    ADMIN_CATALOG_OPERATIONS_SERVICE,
    ADMIN_VOUCHER_INVENTORY_OPERATIONS_SERVICE,
    ADMIN_IDENTITY_SERVICE,
    AdminSessionGuard,
  ],
})
export class AdministrationModule {}
