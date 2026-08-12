import {
  jsonApiCollection,
  jsonApiResource,
} from './configure-http-foundation';

describe('jsonApiResource', () => {
  it('builds a JSON:API resource document without internal fields', () => {
    expect(
      jsonApiResource('health-checks', 'public-api', { status: 'ok' }),
    ).toEqual({
      data: {
        type: 'health-checks',
        id: 'public-api',
        attributes: { status: 'ok' },
      },
    });
  });
});

describe('jsonApiCollection', () => {
  it('builds a collection document with caller-owned pagination metadata', () => {
    expect(
      jsonApiCollection(
        'products',
        [{ id: 'product-public-id', attributes: { name: 'WASSCE' } }],
        { nextCursor: 'opaque-cursor' },
      ),
    ).toEqual({
      data: [
        {
          type: 'products',
          id: 'product-public-id',
          attributes: { name: 'WASSCE' },
        },
      ],
      meta: { nextCursor: 'opaque-cursor' },
    });
  });
});
