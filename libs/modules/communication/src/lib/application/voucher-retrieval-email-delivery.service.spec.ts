import { createSecretKeyring, encryptSecret } from '@edu-api/encryption';
import { VoucherRetrievalEmailDeliveryService } from './voucher-retrieval-email-delivery.service';
import { generateVoucherDeliveryArtifacts } from './voucher-delivery-artifacts';

jest.mock('./voucher-delivery-artifacts', () => ({
  generateVoucherDeliveryArtifacts: jest.fn().mockResolvedValue([]),
}));

describe('VoucherRetrievalEmailDeliveryService recovery', () => {
  function setup() {
    const keyring = createSecretKeyring({
      activeKeyId: 'test',
      fingerprintKey: Buffer.alloc(32, 1),
      keys: [{ id: 'test', material: Buffer.alloc(32, 2) }],
    });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const attempts = {
      create: jest.fn().mockResolvedValue({ id: BigInt(2) }),
      update: jest.fn().mockResolvedValue({}),
    };
    const deliveries = {
      findMany: jest.fn().mockResolvedValue([{ id: BigInt(1) }]),
      updateMany,
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        attemptCount: 1,
        destinationEmail: 'stored@example.test',
        publicId: 'delivery-ref',
        order: {
          publicReference: 'order-ref',
          items: [
            {
              product: { name: 'Voucher', resultCheckerUrl: null },
              fulfilmentUnits: [
                {
                  allocation: {
                    voucher: {
                      serialNumber: 'serial',
                      encryptedPin: encryptSecret('test-pin', keyring),
                    },
                  },
                },
              ],
            },
          ],
        },
      }),
    };
    const transaction = {
      voucherRetrievalEmailDelivery: deliveries,
      voucherRetrievalEmailAttempt: attempts,
    };
    const database = {
      ...transaction,
      $transaction: jest
        .fn()
        .mockImplementation(async (callback) => callback(transaction)),
    };
    const provider = {
      idempotencyRetentionMs: 86400000,
      send: jest.fn().mockResolvedValue({
        status: 'SENT',
        providerMessageId: 'provider-ref',
      }),
    };
    const logger = { error: jest.fn() };
    const service = new VoucherRetrievalEmailDeliveryService(
      database as never,
      provider,
      keyring,
      {
        emailFrom: 'sender@example.test',
        maximumAutomaticAttempts: 5,
        maximumRetryDelayMs: 300000,
        processingLeaseMs: 120000,
        retryBaseDelayMs: 5000,
        supportPhone: '+233240000000',
      },
      logger,
    );
    return {
      service,
      database,
      provider,
      deliveries,
      attempts,
      updateMany,
      logger,
    };
  }

  it('persists successful delivery using the allocated credentials and stable provider reference', async () => {
    const { service, provider, updateMany } = setup();
    await service.processAvailable(1);
    expect(generateVoucherDeliveryArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ pin: 'test-pin', serialNumber: 'serial' }),
    );
    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'stored@example.test',
        idempotencyKey: 'voucher-retrieval-delivery-ref',
      }),
    );
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'SENT' }),
      }),
    );
    expect(
      JSON.stringify(updateMany.mock.calls, (_, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain('test-pin');
  });

  it('logs a preparation failure without leaking exception data', async () => {
    const { service, logger, provider } = setup();
    jest
      .mocked(generateVoucherDeliveryArtifacts)
      .mockRejectedValueOnce(new Error('sensitive-pin-and-provider-token'));
    await service.processAvailable(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Preparing retrieval delivery-ref failed.',
      undefined,
      'VoucherRetrievalEmailDeliveryService',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      'sensitive-pin-and-provider-token',
    );
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('does not downgrade a successful send when saving success fails', async () => {
    const { service, provider, updateMany, deliveries } = setup();
    updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.processAvailable(1)).rejects.toThrow(
      'database unavailable',
    );
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(2);
    const lease = updateMany.mock.calls[0][0].data.processingLeaseUntil;
    deliveries.findMany.mockResolvedValueOnce([
      {
        id: BigInt(1),
        processingLeaseUntil: lease,
        attempts: [{ id: BigInt(2), attemptNumber: 1 }],
      },
    ]);
    await service.recoverStalledDeliveries(1);
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'UNKNOWN',
          lastFailureCategory: 'UNKNOWN_OUTCOME',
        }),
      }),
    );
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it('treats thrown provider calls as unknown outcomes', async () => {
    const { service, provider, updateMany } = setup();
    provider.send.mockRejectedValueOnce(new Error('socket closed'));
    await service.processAvailable(1);
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'UNKNOWN' }),
      }),
    );
  });

  it('does not send when another worker owns the claim', async () => {
    const { service, provider, updateMany } = setup();
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.processAvailable(1)).resolves.toBe(0);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('records pre-send artifact errors as definite failures without calling the provider', async () => {
    const { service, provider, updateMany } = setup();
    jest
      .mocked(generateVoucherDeliveryArtifacts)
      .mockRejectedValueOnce(new Error('invalid artifact'));
    await service.processAvailable(1);
    expect(provider.send).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'NEEDS_ATTENTION',
          lastFailureCategory: 'PERMANENT',
        }),
      }),
    );
  });
});
