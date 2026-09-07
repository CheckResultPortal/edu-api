import { assertCatalogPublicId } from '../domain/catalog-validation';

export const CATALOG_PRODUCT_QUERY = Symbol('CATALOG_PRODUCT_QUERY');

export interface ActiveCatalogProduct {
  readonly catalogGroupPublicId: string;
  readonly code: string;
  readonly currency: string;
  readonly description: string | null;
  readonly name: string;
  readonly publicId: string;
  readonly resultCheckerUrl: string | null;
  readonly sellingPriceMinor: string;
  readonly sortOrder: number;
}

export interface ActiveCatalogProductsPage {
  readonly items: readonly ActiveCatalogProduct[];
  readonly nextCursor: string | null;
}

export interface ActiveCatalogProductsQueryInput {
  readonly catalogGroupPublicId?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface CatalogProductQuery {
  getActiveProduct(publicId: string): Promise<ActiveCatalogProduct | null>;
  listActiveProducts(
    input: ActiveCatalogProductsQueryInput,
  ): Promise<ActiveCatalogProductsPage>;
}

export function parseActiveCatalogProductsQuery(input: {
  readonly catalogGroupPublicId?: string;
  readonly cursor?: string;
  readonly limit?: string;
}): ActiveCatalogProductsQueryInput {
  const limit = input.limit === undefined ? 25 : Number(input.limit);

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(
      'Catalog product limit must be an integer between 1 and 100.',
    );
  }
  if (input.catalogGroupPublicId !== undefined) {
    assertCatalogPublicId(input.catalogGroupPublicId);
  }
  if (input.cursor !== undefined && !isCursor(input.cursor)) {
    throw new Error('Catalog product cursor is invalid.');
  }

  return {
    ...(input.catalogGroupPublicId === undefined
      ? {}
      : { catalogGroupPublicId: input.catalogGroupPublicId }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    limit,
  };
}

export function encodeCatalogProductCursor(publicId: string): string {
  assertCatalogPublicId(publicId);
  return Buffer.from(publicId, 'utf8').toString('base64url');
}

export function decodeCatalogProductCursor(cursor: string): string {
  if (!isCursor(cursor)) {
    throw new Error('Catalog product cursor is invalid.');
  }

  const publicId = Buffer.from(cursor, 'base64url').toString('utf8');
  assertCatalogPublicId(publicId);
  return publicId;
}

function isCursor(value: string): boolean {
  return /^[A-Za-z0-9_-]{22,64}$/.test(value);
}
