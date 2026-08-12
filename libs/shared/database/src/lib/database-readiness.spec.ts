import { isDatabaseReady } from './database-readiness';

describe('isDatabaseReady', () => {
  it('checks PostgreSQL with a bounded constant query', async () => {
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };

    await expect(isDatabaseReady(client)).resolves.toBe(true);
    expect(client.$queryRawUnsafe).toHaveBeenCalledWith('SELECT 1');
  });

  it('returns false without exposing a database failure', async () => {
    await expect(
      isDatabaseReady({
        $queryRawUnsafe: jest.fn().mockRejectedValue(new Error()),
      }),
    ).resolves.toBe(false);
  });
});
