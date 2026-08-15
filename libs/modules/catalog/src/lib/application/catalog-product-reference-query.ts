import { assertCatalogPublicId } from '../domain/catalog-validation';

export const CATALOG_PRODUCT_REFERENCE_QUERY = Symbol(
  'CATALOG_PRODUCT_REFERENCE_QUERY',
);

export interface CatalogProductReference {
  readonly id: bigint;
  readonly publicId: string;
}

export interface CatalogProductReferenceQuery {
  getProductReference(
    publicId: string,
  ): Promise<CatalogProductReference | null>;
}

export function assertCatalogProductReference(publicId: string): void {
  assertCatalogPublicId(publicId);
}
