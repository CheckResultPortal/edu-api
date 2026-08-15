import axios from 'axios';

describe('GET /v1/health/live', () => {
  it('returns the admin API health response', async () => {
    const res = await axios.get('/v1/health/live');

    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      data: {
        type: 'health-checks',
        id: 'admin-api',
        attributes: { status: 'ok' },
      },
      meta: { correlationId: expect.any(String) },
    });
  });

  it('returns ready when PostgreSQL and Redis are available', async () => {
    const res = await axios.get('/v1/health/ready');

    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      data: {
        type: 'health-checks',
        id: 'admin-api',
        attributes: { status: 'ok' },
      },
      meta: { correlationId: expect.any(String) },
    });
  });

  it('publishes the generated OpenAPI health contract', async () => {
    const res = await axios.get('/v1/openapi.json');

    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      openapi: '3.0.0',
      info: {
        title: 'admin-api API',
        version: '1.0.0',
      },
    });
    expect(res.data.paths).toEqual(
      expect.objectContaining({
        '/v1/health/live': expect.objectContaining({ get: expect.any(Object) }),
        '/v1/health/ready': expect.objectContaining({
          get: expect.any(Object),
        }),
        '/v1/admin/catalog-groups': expect.objectContaining({
          post: expect.any(Object),
        }),
        '/v1/admin/catalog-groups/{publicId}': expect.objectContaining({
          patch: expect.any(Object),
        }),
        '/v1/admin/products': expect.objectContaining({
          post: expect.any(Object),
        }),
        '/v1/admin/products/{publicId}': expect.objectContaining({
          patch: expect.any(Object),
        }),
        '/v1/admin/products/{publicId}/price': expect.objectContaining({
          put: expect.any(Object),
        }),
        '/v1/admin/products/{publicId}/activate': expect.objectContaining({
          post: expect.any(Object),
        }),
        '/v1/admin/products/{publicId}/deactivate': expect.objectContaining({
          post: expect.any(Object),
        }),
        '/v1/admin/voucher-batches/import': expect.objectContaining({
          post: expect.any(Object),
        }),
        '/v1/admin/voucher-batches/{publicId}': expect.objectContaining({
          get: expect.any(Object),
        }),
        '/v1/admin/voucher-batches/{publicId}/activate':
          expect.objectContaining({
            post: expect.any(Object),
          }),
        '/v1/admin/voucher-batches/{publicId}/discard': expect.objectContaining(
          {
            post: expect.any(Object),
          },
        ),
      }),
    );
  });

  it('hosts interactive API documentation outside production', async () => {
    const res = await axios.get('/v1/api/docs');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('rejects an unauthenticated catalog write', async () => {
    const res = await axios.post(
      '/v1/admin/catalog-groups',
      { code: 'WAEC', name: 'WAEC', sortOrder: 0 },
      { validateStatus: () => true },
    );

    expect(res.status).toBe(401);
    expect(res.data).toMatchObject({
      errors: [
        expect.objectContaining({ code: 'ADMIN_AUTHENTICATION_REQUIRED' }),
      ],
    });
  });

  it('rejects an unauthenticated voucher import before reading credentials', async () => {
    const res = await axios.post(
      '/v1/admin/voucher-batches/import?productPublicId=1f39d1f1-0e1b-4d7a-9b3a-fc3adca653a1&reference=test-import',
      'serialNumber,pin\nSERIAL-1,PIN-MUST-NOT-BE-PROCESSED\n',
      {
        headers: { 'content-type': 'text/csv' },
        validateStatus: () => true,
      },
    );

    expect(res.status).toBe(401);
    expect(res.data).toMatchObject({
      errors: [
        expect.objectContaining({ code: 'ADMIN_AUTHENTICATION_REQUIRED' }),
      ],
    });
  });

  it('does not expose public Catalog routes from the Admin API', async () => {
    const res = await axios.get('/v1/products', {
      validateStatus: () => true,
    });

    expect(res.status).toBe(404);
  });
});
