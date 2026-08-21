import type { DatabaseTransactionClient } from '@edu-api/database';

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
      allocateWaitingUnitsForProduct: jest.fn(),
      drainNextWaitingProduct: jest.fn(),
      findProductIdByOrderPublicReference: jest.fn(),
      findProductIdByProductPublicId: jest.fn(),
    };
    service = new DefaultVoucherAllocationService(repository);
  });

  it('resolves the order product and allocates at most the paid quantity', async () => {
    repository.findProductIdByOrderPublicReference.mockResolvedValue(
      BigInt(42),
    );
    repository.allocateWaitingUnitsForProduct.mockResolvedValue({
      allocatedCount: 2,
      examinedCount: 2,
      stoppedForZeroStock: false,
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
    expect(repository.allocateWaitingUnitsForProduct).toHaveBeenCalledWith(
      transaction,
      BigInt(42),
      2,
    );
  });

  it('stops immediately after the first zero-stock result', async () => {
    repository.allocateWaitingUnitsForProduct.mockResolvedValue({
      allocatedCount: 0,
      examinedCount: 1,
      stoppedForZeroStock: true,
    });

    await expect(
      service.allocateWaitingUnitsForProduct(transaction, BigInt(7), 500),
    ).resolves.toEqual({
      allocatedCount: 0,
      examinedCount: 1,
      stoppedForZeroStock: true,
    });
    expect(repository.allocateWaitingUnitsForProduct).toHaveBeenCalledWith(
      transaction,
      BigInt(7),
      500,
    );
  });

  it('stops when no waiting obligation remains', async () => {
    repository.allocateWaitingUnitsForProduct.mockResolvedValue({
      allocatedCount: 1,
      examinedCount: 1,
      stoppedForZeroStock: false,
    });

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
    expect(repository.allocateWaitingUnitsForProduct).not.toHaveBeenCalled();
  });

  it('does nothing when a stock event product has no waiting obligations', async () => {
    repository.findProductIdByProductPublicId.mockResolvedValue(null);

    await expect(
      service.allocateWaitingUnitsForProductPublicId(
        transaction,
        '123e4567-e89b-12d3-a456-426614174000',
        250,
      ),
    ).resolves.toEqual({
      allocatedCount: 0,
      examinedCount: 0,
      stoppedForZeroStock: false,
    });
    expect(repository.allocateWaitingUnitsForProduct).not.toHaveBeenCalled();
  });
});
