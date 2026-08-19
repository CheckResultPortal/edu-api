import {
  DefaultVoucherAllocationService,
  type VoucherAllocationRepository,
} from './voucher-allocation-service';

describe('DefaultVoucherAllocationService', () => {
  const transaction = {} as DatabaseTransactionClient;
  let repository: jest.Mocked<VoucherAllocationRepository>;
  let service: DefaultVoucherAllocationService;

  beforeEach(() => {
    repository = {
      allocateNextWaitingUnitForProduct: jest.fn(),
      findProductIdByOrderPublicReference: jest.fn(),
    };
    service = new DefaultVoucherAllocationService(repository);
  });

  it('resolves the order product and allocates at most the paid quantity', async () => {
    repository.findProductIdByOrderPublicReference.mockResolvedValue(
      BigInt(42),
    );
    repository.allocateNextWaitingUnitForProduct
      .mockResolvedValueOnce({
        outcome: 'ALLOCATED',
        allocationPublicReference: 'd48e89f1-7f8e-4a6f-9988-5f5647a9988a',
        fulfilmentUnitPublicReference: '123e4567-e89b-12d3-a456-426614174000',
        productId: BigInt(42),
      })
      .mockResolvedValueOnce({
        outcome: 'ALLOCATED',
        allocationPublicReference: 'b8ce9dc7-f417-4d82-ae47-f54109b8bbb7',
        fulfilmentUnitPublicReference: '8581f43a-2318-432b-9594-ad0621839477',
        productId: BigInt(42),
      });

    await expect(
      service.allocateUnitsForOrder(
        transaction,
        'f1af1786-60a7-4ef1-83b8-a6e83547c800',
        2,
      ),
    ).resolves.toEqual({
      allocatedCount: 2,
      examinedCount: 2,
      stoppedForZeroStock: false,
    });
    expect(repository.allocateNextWaitingUnitForProduct).toHaveBeenCalledTimes(
      2,
    );
  });

  it('stops immediately after the first zero-stock result', async () => {
    repository.allocateNextWaitingUnitForProduct.mockResolvedValue({
      outcome: 'ZERO_STOCK',
      fulfilmentUnitPublicReference: '123e4567-e89b-12d3-a456-426614174000',
      productId: BigInt(7),
    });

    await expect(
      service.allocateWaitingUnitsForProduct(transaction, BigInt(7), 500),
    ).resolves.toEqual({
      allocatedCount: 0,
      examinedCount: 1,
      stoppedForZeroStock: true,
    });
    expect(repository.allocateNextWaitingUnitForProduct).toHaveBeenCalledTimes(
      1,
    );
  });

  it('stops when no waiting obligation remains', async () => {
    repository.allocateNextWaitingUnitForProduct
      .mockResolvedValueOnce({
        outcome: 'ALLOCATED',
        allocationPublicReference: 'd48e89f1-7f8e-4a6f-9988-5f5647a9988a',
        fulfilmentUnitPublicReference: '123e4567-e89b-12d3-a456-426614174000',
        productId: BigInt(5),
      })
      .mockResolvedValueOnce({ outcome: 'NO_WAITING', productId: BigInt(5) });

    await expect(
      service.allocateWaitingUnitsForProduct(transaction, BigInt(5), 20),
    ).resolves.toEqual({
      allocatedCount: 1,
      examinedCount: 1,
      stoppedForZeroStock: false,
    });
  });

  it('rejects a payment event without a matching fulfilment obligation', async () => {
    repository.findProductIdByOrderPublicReference.mockResolvedValue(null);

    await expect(
      service.allocateUnitsForOrder(
        transaction,
        'f1af1786-60a7-4ef1-83b8-a6e83547c800',
        1,
      ),
    ).rejects.toThrow(
      'PaymentSucceeded does not reference a paid fulfilment obligation.',
    );
  });

  it('rejects a non-positive or fractional allocation bound', async () => {
    await expect(
      service.allocateWaitingUnitsForProduct(transaction, BigInt(5), 0),
    ).rejects.toThrow('maximumUnits must be a positive integer.');
    await expect(
      service.allocateWaitingUnitsForProduct(transaction, BigInt(5), 1.5),
    ).rejects.toThrow('maximumUnits must be a positive integer.');
    expect(repository.allocateNextWaitingUnitForProduct).not.toHaveBeenCalled();
  });
});
import type { DatabaseTransactionClient } from '@edu-api/database';
