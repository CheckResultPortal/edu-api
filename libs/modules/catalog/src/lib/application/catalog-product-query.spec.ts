import {
  decodeCatalogProductCursor,
  encodeCatalogProductCursor,
  parseActiveCatalogProductsQuery,
} from './catalog-product-query';

const publicId = '1f39d1f1-0e1b-4d7a-9b3a-fc3adca653a1';

describe('catalog public query contract', () => {
  it('uses a bounded default page and supports opaque cursors', () => {
    const cursor = encodeCatalogProductCursor(publicId);

    expect(parseActiveCatalogProductsQuery({ cursor })).toEqual({
      cursor,
      limit: 25,
    });
    expect(decodeCatalogProductCursor(cursor)).toBe(publicId);
  });

  it('rejects unbounded or malformed public queries', () => {
    expect(() => parseActiveCatalogProductsQuery({ limit: '101' })).toThrow(
      'between 1 and 100',
    );
    expect(() =>
      parseActiveCatalogProductsQuery({ cursor: 'bad cursor' }),
    ).toThrow('cursor is invalid');
  });
});
