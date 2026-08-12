import { closeQueue } from './queue-lifecycle';

describe('closeQueue', () => {
  it('closes the BullMQ queue during shutdown', async () => {
    const queue = { close: jest.fn().mockResolvedValue(undefined) };

    await closeQueue(queue);

    expect(queue.close).toHaveBeenCalledTimes(1);
  });
});
