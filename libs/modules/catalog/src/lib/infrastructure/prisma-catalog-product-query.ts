import type { DatabaseClient } from '@edu-api/database';

import {
  type ActiveCatalogProduct,
  type ActiveCatalogProductsPage,
  type ActiveCatalogProductsQueryInput,
  decodeCatalogProductCursor,
  encodeCatalogProductCursor,
  type CatalogProductQuery,
} from '../application/catalog-product-query';

export class PrismaCatalogProductQuery implements CatalogProductQuery {
  constructor(private readonly database: DatabaseClient) {}

  async getActiveProduct(
    publicId: string,
  ): Promise<ActiveCatalogProduct | null> {
    const product = await this.database.product.findFirst({
      where: { publicId, isActive: true },
      select: productSelection,
    });

    return product === null ? null : toActiveCatalogProduct(product);
  }

  async listActiveProducts(
    input: ActiveCatalogProductsQueryInput,
  ): Promise<ActiveCatalogProductsPage> {
    const products = await this.database.product.findMany({
      where: {
        isActive: true,
        ...(input.catalogGroupPublicId === undefined
          ? {}
          : { catalogGroup: { publicId: input.catalogGroupPublicId } }),
      },
      select: productSelection,
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }, { id: 'asc' }],
      ...(input.cursor === undefined
        ? {}
        : {
            cursor: { publicId: decodeCatalogProductCursor(input.cursor) },
            skip: 1,
          }),
      take: input.limit + 1,
    });

    const hasNextPage = products.length > input.limit;
    const page = hasNextPage ? products.slice(0, input.limit) : products;
    const lastProduct = page.at(-1);

    return {
      items: page.map(toActiveCatalogProduct),
      nextCursor:
        hasNextPage && lastProduct !== undefined
          ? encodeCatalogProductCursor(lastProduct.publicId)
          : null,
    };
  }
}

const productSelection = {
  publicId: true,
  code: true,
  name: true,
  description: true,
  sellingPriceMinor: true,
  currency: true,
  resultCheckerUrl: true,
  sortOrder: true,
  catalogGroup: { select: { publicId: true } },
} as const;

function toActiveCatalogProduct(product: {
  readonly catalogGroup: { readonly publicId: string };
  readonly code: string;
  readonly currency: string;
  readonly description: string | null;
  readonly name: string;
  readonly publicId: string;
  readonly resultCheckerUrl: string | null;
  readonly sellingPriceMinor: bigint;
  readonly sortOrder: number;
}): ActiveCatalogProduct {
  return {
    catalogGroupPublicId: product.catalogGroup.publicId,
    code: product.code,
    currency: product.currency,
    description: product.description,
    name: product.name,
    publicId: product.publicId,
    resultCheckerUrl: product.resultCheckerUrl,
    sellingPriceMinor: product.sellingPriceMinor.toString(),
    sortOrder: product.sortOrder,
  };
}
