import { Module } from '@nestjs/common';

import {
  DATABASE_CLIENT,
  DatabaseModule,
  type DatabaseClient,
} from '@edu-api/database';

import { CATALOG_PRODUCT_QUERY } from './application/catalog-product-query';
import { PrismaCatalogProductQuery } from './infrastructure/prisma-catalog-product-query';
import { PublicCatalogController } from './presentation/public-catalog.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [PublicCatalogController],
  providers: [
    {
      provide: CATALOG_PRODUCT_QUERY,
      inject: [DATABASE_CLIENT],
      useFactory: (database: DatabaseClient): PrismaCatalogProductQuery =>
        new PrismaCatalogProductQuery(database),
    },
  ],
  exports: [CATALOG_PRODUCT_QUERY],
})
export class CatalogModule {}
