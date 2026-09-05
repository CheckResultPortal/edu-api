import { PrismaOrderCreationRepository } from './prisma-order-creation.repository';
import { OrderCreationUnavailableError } from '../application/order-creation-errors';

describe('customer code collision recovery', () => {
  const collision = { code: 'P2002', meta: { target: ['customerCode'] } };
  it('retries a rolled-back collision without replaying another order', async () => {
    const result = { customerCode: '654321' };
    const transaction = jest
      .fn()
      .mockRejectedValueOnce(collision)
      .mockResolvedValueOnce(result);
    const repository = new PrismaOrderCreationRepository(
      { $transaction: transaction } as never,
      {} as never,
    );
    await expect(repository.create({} as never)).resolves.toBe(result);
    expect(transaction).toHaveBeenCalledTimes(2);
  });
  it('bounds collision retries and fails without reusing a code', async () => {
    const transaction = jest.fn().mockRejectedValue(collision);
    const repository = new PrismaOrderCreationRepository(
      { $transaction: transaction } as never,
      {} as never,
    );
    await expect(repository.create({} as never)).rejects.toBeInstanceOf(
      OrderCreationUnavailableError,
    );
    expect(transaction).toHaveBeenCalledTimes(3);
  });
});
