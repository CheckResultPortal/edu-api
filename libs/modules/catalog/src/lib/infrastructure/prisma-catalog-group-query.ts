import type { DatabaseClient } from '@edu-api/database';

import {
  type CatalogGroupQuery,
  decodeCatalogGroupCursor,
  encodeCatalogGroupCursor,
  type PublicCatalogGroup,
} from '../application/catalog-group-query';

export class PrismaCatalogGroupQuery implements CatalogGroupQuery {
  constructor(private readonly database: DatabaseClient) {}

  async listGroups(input: {
    readonly cursor?: string;
    readonly limit: number;
  }) {
    const groups = await this.database.catalogGroup.findMany({
      ...(input.cursor === undefined
        ? {}
        : {
            cursor: { publicId: decodeCatalogGroupCursor(input.cursor) },
            skip: 1,
          }),
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      take: input.limit + 1,
      select: {
        code: true,
        name: true,
        publicId: true,
        sortOrder: true,
        parent: { select: { publicId: true } },
      },
    });
    const hasMore = groups.length > input.limit;
    const page = groups.slice(0, input.limit);
    return {
      items: page.map(toPublicGroup),
      nextCursor:
        hasMore && page.at(-1) !== undefined
          ? encodeCatalogGroupCursor(page.at(-1)!.publicId)
          : null,
    };
  }
}

function toPublicGroup(group: {
  readonly code: string;
  readonly name: string;
  readonly parent: { readonly publicId: string } | null;
  readonly publicId: string;
  readonly sortOrder: number;
}): PublicCatalogGroup {
  return {
    code: group.code,
    name: group.name,
    parentPublicId: group.parent?.publicId ?? null,
    publicId: group.publicId,
    sortOrder: group.sortOrder,
  };
}
