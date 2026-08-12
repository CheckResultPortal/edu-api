import { closeDatabaseClient } from './database-lifecycle';

describe('closeDatabaseClient', () => {
  it('disconnects the PostgreSQL client', async () => {
    const client = { $disconnect: jest.fn().mockResolvedValue(undefined) };

    await closeDatabaseClient(client);

    expect(client.$disconnect).toHaveBeenCalledTimes(1);
  });
});
