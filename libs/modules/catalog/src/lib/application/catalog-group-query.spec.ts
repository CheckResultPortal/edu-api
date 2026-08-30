import {
  decodeCatalogGroupCursor,
  encodeCatalogGroupCursor,
  parseCatalogGroupsQuery,
} from './catalog-group-query';

describe('catalog group public query contract', () => {
  const publicId = '1f39d1f1-0e1b-4d7a-9b3a-fc3adca653a1';

  it('uses bounded pagination with an opaque cursor', () => {
    const cursor = encodeCatalogGroupCursor(publicId);
    expect(parseCatalogGroupsQuery({ cursor })).toEqual({ cursor, limit: 50 });
    expect(decodeCatalogGroupCursor(cursor)).toBe(publicId);
  });

  it('rejects malformed or unbounded requests', () => {
    expect(() => parseCatalogGroupsQuery({ limit: '101' })).toThrow(
      'between 1 and 100',
    );
    expect(() => parseCatalogGroupsQuery({ cursor: 'not-a-cursor' })).toThrow(
      'cursor is invalid',
    );
  });
});
