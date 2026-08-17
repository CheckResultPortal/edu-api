import { Module } from '@nestjs/common';

import {
  DATABASE_CLIENT,
  DatabaseModule,
  type DatabaseClient,
} from '@edu-api/database';

import { CATALOG_ADMIN_SERVICE } from './application/catalog-admin-service';
import { CATALOG_PRODUCT_REFERENCE_QUERY } from './application/catalog-product-reference-query';
import { CATALOG_PRODUCT_QUERY } from './application/catalog-product-query';
import { PrismaCatalogAdminService } from './infrastructure/prisma-catalog-admin.service';
import { PrismaCatalogProductReferenceQuery } from './infrastructure/prisma-catalog-product-reference-query';
import { PrismaCatalogProductQuery } from './infrastructure/prisma-catalog-product-query';
import {
  PrismaTransactionalOrderProductQuery,
  TRANSACTIONAL_ORDER_PRODUCT_QUERY,
} from './infrastructure/prisma-transactional-order-product-query';
import { PublicCatalogController } from './presentation/public-catalog.controller';

@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: CATALOG_PRODUCT_QUERY,
      inject: [DATABASE_CLIENT],
      useFactory: (database: DatabaseClient): PrismaCatalogProductQuery =>
        new PrismaCatalogProductQuery(database),
    },
    {
      provide: CATALOG_PRODUCT_REFERENCE_QUERY,
      inject: [DATABASE_CLIENT],
      useFactory: (
        database: DatabaseClient,
      ): PrismaCatalogProductReferenceQuery =>
        new PrismaCatalogProductReferenceQuery(database),
    },
    PrismaCatalogAdminService,
    PrismaTransactionalOrderProductQuery,
    {
      provide: CATALOG_ADMIN_SERVICE,
      useExisting: PrismaCatalogAdminService,
    },
    {
      provide: TRANSACTIONAL_ORDER_PRODUCT_QUERY,
      useExisting: PrismaTransactionalOrderProductQuery,
    },
  ],
  exports: [
    CATALOG_ADMIN_SERVICE,
    CATALOG_PRODUCT_QUERY,
    CATALOG_PRODUCT_REFERENCE_QUERY,
    TRANSACTIONAL_ORDER_PRODUCT_QUERY,
  ],
})
export class CatalogCoreModule {}

@Module({
  imports: [CatalogCoreModule],
  controllers: [PublicCatalogController],
})
export class CatalogModule {}
