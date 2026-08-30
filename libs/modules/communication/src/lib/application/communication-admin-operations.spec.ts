import type { DatabaseClient } from '@edu-api/database';

import {
  CommunicationRetryConflictError,
  PrismaCommunicationAdminOperations,
} from './communication-admin-operations';

describe('PrismaCommunicationAdminOperations', () => {
  const input = {
    actorAdminUserId: BigInt(12),
    correlationId: 'correlation-id',
    deliveryPublicId: '4e310bf9-32e6-43d0-8d42-f52f7543d092',
    idempotencyKey: 'retry:0123456789abcdef',
  };

  it('atomically schedules one safe retry and its audit event', async () => {
    const transaction = transactionMock({
      delivery: {
        id: BigInt(8),
        lastFailureCategory: 'PERMANENT',
        state: 'NEEDS_ATTENTION',
      },
    });
    const service = new PrismaCommunicationAdminOperations(
      databaseMock(transaction),
    );

    await expect(service.requestRetry(input)).resolves.toEqual({
      changed: true,
      deliveryPublicId: input.deliveryPublicId,
    });
    expect(transaction.communicationDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: BigInt(8),
          state: 'NEEDS_ATTENTION',
        }),
        data: expect.objectContaining({ state: 'PENDING' }),
      }),
    );
    expect(transaction.adminSecurityEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adminUserId: input.actorAdminUserId,
        eventType: 'COMMUNICATION_DELIVERY_RETRY_REQUESTED',
      }),
    });
  });

  it('does not retry an ambiguous provider outcome', async () => {
    const transaction = transactionMock({
      delivery: {
        id: BigInt(8),
        lastFailureCategory: 'UNKNOWN_OUTCOME',
        state: 'NEEDS_ATTENTION',
      },
    });
    const service = new PrismaCommunicationAdminOperations(
      databaseMock(transaction),
    );

    await expect(service.requestRetry(input)).rejects.toBeInstanceOf(
      CommunicationRetryConflictError,
    );
    expect(transaction.communicationDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('rejects one idempotency key reused for another delivery', async () => {
    const transaction = transactionMock({
      existing: {
        requestFingerprint: 'different-fingerprint',
        responseReference: null,
        responseStatus: null,
        status: 'COMPLETED',
      },
    });
    const service = new PrismaCommunicationAdminOperations(
      databaseMock(transaction),
    );

    await expect(service.requestRetry(input)).rejects.toBeInstanceOf(
      CommunicationRetryConflictError,
    );
  });
});

function databaseMock(transaction: ReturnType<typeof transactionMock>) {
  return {
    $transaction: jest.fn(
      async (operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    ),
  } as unknown as DatabaseClient;
}

function transactionMock(options: {
  readonly delivery?: {
    readonly id: bigint;
    readonly lastFailureCategory: string;
    readonly state: string;
  };
  readonly existing?: {
    readonly requestFingerprint: string;
    readonly responseReference: string | null;
    readonly responseStatus: number | null;
    readonly status: string;
  };
}) {
  return {
    idempotencyRecord: {
      findUnique: jest.fn().mockResolvedValue(options.existing ?? null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    communicationDelivery: {
      findUnique: jest.fn().mockResolvedValue(options.delivery ?? null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    adminSecurityEvent: { create: jest.fn().mockResolvedValue({}) },
  };
}
