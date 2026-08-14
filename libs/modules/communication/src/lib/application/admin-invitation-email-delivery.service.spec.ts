import { AdminInvitationEmailDeliveryService } from './admin-invitation-email-delivery.service';

describe('AdminInvitationEmailDeliveryService', () => {
  it('clamps worker batches to a bounded maximum', async () => {
    const database = {
      $transaction: jest.fn().mockImplementation(async (callback) =>
        callback({
          $queryRaw: jest.fn().mockResolvedValue([]),
          outboxEvent: { updateMany: jest.fn() },
        }),
      ),
    };
    const service = new AdminInvitationEmailDeliveryService(
      database as never,
      {
        applicationOrigin: 'https://admin.example.com',
        hmacKey: Buffer.alloc(32, 1),
        secretEncryptionKeyId: 'test-v1',
        secretEncryptionKey: Buffer.alloc(32, 2),
      },
      { idempotencyRetentionMs: 24 * 60 * 60 * 1000, send: jest.fn() },
      {
        from: 'admin@example.com',
        maximumAutomaticAttempts: 5,
        providerName: 'resend',
        workerId: 'worker-1',
      },
    );

    await expect(service.processAvailable(1_000)).resolves.toBe(0);
    expect(database.$transaction).toHaveBeenCalledTimes(1);
  });
});
