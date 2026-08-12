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
      }),
    );
  });
});
