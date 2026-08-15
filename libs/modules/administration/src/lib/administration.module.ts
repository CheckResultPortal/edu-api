import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  DATABASE_CLIENT,
  DatabaseModule,
  type DatabaseClient,
} from '@edu-api/database';
import {
  CATALOG_ADMIN_SERVICE,
  CatalogCoreModule,
  type CatalogAdminService,
} from '@edu-api/catalog';

import {
  ADMIN_CATALOG_OPERATIONS_SERVICE,
  PrismaAdminCatalogOperationsService,
} from './application/admin-catalog-operations';
import { decodeBase64UrlKey } from './application/admin-identity-configuration';
import { ADMIN_IDENTITY_SERVICE } from './application/admin-identity-ports';
import { PrismaAdminIdentityService } from './application/prisma-admin-identity.service';
import { AdminIdentityController } from './presentation/admin-identity.controller';
import { AdminCatalogController } from './presentation/admin-catalog.controller';
import { AdminSessionGuard } from './presentation/admin-session.guard';

@Module({
  imports: [DatabaseModule, CatalogCoreModule],
  controllers: [AdminIdentityController, AdminCatalogController],
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
    AdminSessionGuard,
  ],
  exports: [
    ADMIN_CATALOG_OPERATIONS_SERVICE,
    ADMIN_IDENTITY_SERVICE,
    AdminSessionGuard,
  ],
})
export class AdministrationModule {}
