import { assertCatalogPublicId } from '../domain/catalog-validation';

export const CATALOG_GROUP_QUERY = Symbol('CATALOG_GROUP_QUERY');

export interface PublicCatalogGroup {
  readonly code: string;
  readonly name: string;
  readonly parentPublicId: string | null;
  readonly publicId: string;
  readonly sortOrder: number;
}

export interface CatalogGroupQuery {
  listGroups(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly PublicCatalogGroup[];
    readonly nextCursor: string | null;
  }>;
}

export function parseCatalogGroupsQuery(input: {
  readonly cursor?: string;
  readonly limit?: string;
}): { readonly cursor?: string; readonly limit: number } {
  const limit = input.limit === undefined ? 50 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(
      'Catalog group limit must be an integer between 1 and 100.',
    );
  }
  if (input.cursor !== undefined) decodeCatalogGroupCursor(input.cursor);
  return {
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    limit,
  };
}

export function encodeCatalogGroupCursor(publicId: string): string {
  assertCatalogPublicId(publicId);
  return Buffer.from(publicId, 'utf8').toString('base64url');
}

export function decodeCatalogGroupCursor(cursor: string): string {
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(cursor)) {
    throw new Error('Catalog group cursor is invalid.');
  }
  const publicId = Buffer.from(cursor, 'base64url').toString('utf8');
  assertCatalogPublicId(publicId);
  return publicId;
}
