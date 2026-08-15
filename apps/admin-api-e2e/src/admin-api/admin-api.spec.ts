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
      }),
    );
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

  it('does not expose public Catalog routes from the Admin API', async () => {
    const res = await axios.get('/v1/products', {
      validateStatus: () => true,
    });

    expect(res.status).toBe(404);
  });
});
