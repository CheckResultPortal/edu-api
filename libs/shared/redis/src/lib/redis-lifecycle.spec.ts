import { closeRedisClient } from './redis-lifecycle';

describe('closeRedisClient', () => {
  it('disconnects a client that never connected', async () => {
    const client = {
      disconnect: jest.fn(),
      quit: jest.fn(),
      status: 'wait',
    };

    await closeRedisClient(client);

    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(client.quit).not.toHaveBeenCalled();
  });
});
