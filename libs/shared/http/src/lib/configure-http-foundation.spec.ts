import { jsonApiResource } from './configure-http-foundation';

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
