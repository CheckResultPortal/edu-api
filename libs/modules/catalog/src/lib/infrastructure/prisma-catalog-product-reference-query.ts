import type { DatabaseClient } from '@edu-api/database';

import type {
  CatalogProductReference,
  CatalogProductReferenceQuery,
} from '../application/catalog-product-reference-query';

export class PrismaCatalogProductReferenceQuery
  implements CatalogProductReferenceQuery
{
  constructor(private readonly database: DatabaseClient) {}

  async getProductReference(
    publicId: string,
  ): Promise<CatalogProductReference | null> {
    return this.database.product.findUnique({
      where: { publicId },
      select: { id: true, publicId: true },
    });
  }
}
