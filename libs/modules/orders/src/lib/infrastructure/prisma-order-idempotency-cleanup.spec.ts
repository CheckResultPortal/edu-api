import type { DatabaseClient } from '@edu-api/database';

import { PrismaOrderIdempotencyCleanup } from './prisma-order-idempotency-cleanup';

describe('PrismaOrderIdempotencyCleanup', () => {
  it('selects and deletes only one bounded expired batch', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([{ id: BigInt(11) }, { id: BigInt(12) }]);
    const deleteMany = jest.fn().mockResolvedValue({ count: 2 });
    const cleanup = new PrismaOrderIdempotencyCleanup({
      idempotencyRecord: { findMany, deleteMany },
    } as unknown as DatabaseClient);
    const now = new Date('2026-08-18T12:00:00.000Z');

    await expect(cleanup.deleteExpired(2, now)).resolves.toBe(2);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        where: {
          scope: 'guest-order-create',
          expiresAt: { lte: now },
        },
      }),
    );
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        scope: 'guest-order-create',
        expiresAt: { lte: now },
        id: { in: [BigInt(11), BigInt(12)] },
      },
    });
  });

  it('does not issue an unbounded delete when nothing has expired', async () => {
    const deleteMany = jest.fn();
    const cleanup = new PrismaOrderIdempotencyCleanup({
      idempotencyRecord: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany,
      },
    } as unknown as DatabaseClient);

    await expect(cleanup.deleteExpired(1)).resolves.toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('rejects an unsafe batch size', async () => {
    const cleanup = new PrismaOrderIdempotencyCleanup(
      {} as unknown as DatabaseClient,
    );

    await expect(cleanup.deleteExpired(0)).rejects.toThrow(
      'between 1 and 5000',
    );
  });
});
