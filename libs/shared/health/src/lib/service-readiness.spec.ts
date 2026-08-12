import { assessServiceReadiness } from './service-readiness';

describe('assessServiceReadiness', () => {
  it('is ready only when PostgreSQL and Redis are both available', async () => {
    await expect(
      assessServiceReadiness({
        database: { $queryRawUnsafe: jest.fn().mockResolvedValue(1) },
        redis: { ping: jest.fn().mockResolvedValue('PONG') },
      }),
    ).resolves.toEqual({ database: true, redis: true, ready: true });
  });

  it('reports unavailable dependencies without throwing their details', async () => {
    await expect(
      assessServiceReadiness({
        database: { $queryRawUnsafe: jest.fn().mockRejectedValue(new Error()) },
        redis: { ping: jest.fn().mockResolvedValue('PONG') },
      }),
    ).resolves.toEqual({ database: false, redis: true, ready: false });
  });
});
