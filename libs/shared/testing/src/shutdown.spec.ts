import { closeResources } from './shutdown';

describe('closeResources', () => {
  it('closes resources in reverse dependency order', async () => {
    const closed: string[] = [];
    await closeResources([
      { close: async () => void closed.push('database') },
      { close: async () => void closed.push('redis') },
      { close: async () => void closed.push('queue') },
    ]);
    expect(closed).toEqual(['queue', 'redis', 'database']);
  });
});
