import type { DatabaseClient } from '@edu-api/database';

const idempotencyScope = 'guest-order-create';

export class PrismaOrderIdempotencyCleanup {
  constructor(private readonly database: DatabaseClient) {}

  async deleteExpired(batchSize: number, now = new Date()): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
      throw new Error(
        'Order idempotency cleanup batch size must be between 1 and 5000.',
      );
    }

    const expired = await this.database.idempotencyRecord.findMany({
      where: { scope: idempotencyScope, expiresAt: { lte: now } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
      select: { id: true },
    });
    if (expired.length === 0) return 0;

    const deleted = await this.database.idempotencyRecord.deleteMany({
      where: {
        scope: idempotencyScope,
        expiresAt: { lte: now },
        id: { in: expired.map((record) => record.id) },
      },
    });
    return deleted.count;
  }
}
