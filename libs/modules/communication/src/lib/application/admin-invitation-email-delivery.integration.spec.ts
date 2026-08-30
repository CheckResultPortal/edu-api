import { randomBytes, randomUUID } from 'node:crypto';

import { createPrismaClient, type DatabaseClient } from '@edu-api/database';
import { createSecretKeyring, encryptSecret } from '@edu-api/encryption';

import { AdminInvitationEmailDeliveryService } from './admin-invitation-email-delivery.service';
import { type AdminInvitationDeliveryConfiguration } from './admin-invitation-delivery-reader';
import type { EmailProvider } from './email-provider';

const databaseUrl = process.env.COMMUNICATION_TEST_DATABASE_URL;
const describeWithDatabase =
  databaseUrl === undefined ? describe.skip : describe;
const configuration: AdminInvitationDeliveryConfiguration = {
  applicationOrigin: 'https://admin.example.test',
  hmacKey: Buffer.alloc(32, 21),
  secretEncryptionKeyId: 'test-v1',
  secretEncryptionKey: Buffer.alloc(32, 22),
};

describeWithDatabase('AdminInvitationEmailDeliveryService (PostgreSQL)', () => {
  let database: DatabaseClient;
  let actorId: bigint;
  let actorEmail: string;
  let invitationEmail: string;

  beforeAll(async () => {
    database = await createPrismaClient({ DATABASE_URL: databaseUrl });
  });

  beforeEach(async () => {
    const suffix = randomUUID();
    actorEmail = `admin-${suffix}@integration.test`;
    invitationEmail = `operations-${suffix}@integration.test`;
    const administrator = await database.adminUser.create({
      data: {
        email: actorEmail,
        passwordHash: 'not-used-by-this-worker-test',
        role: 'SUPER_ADMIN',
      },
      select: { id: true },
    });
    actorId = administrator.id;
  });

  afterEach(async () => {
    const invitations = await database.adminInvitation.findMany({
      where: { invitedByAdminUserId: actorId },
      select: { id: true },
    });
    const invitationIds = invitations.map((invitation) => invitation.id);
    if (invitationIds.length !== 0) {
      const deliveries = await database.adminInvitationEmailDelivery.findMany({
        where: { invitationId: { in: invitationIds } },
        select: { id: true },
      });
      const deliveryIds = deliveries.map((delivery) => delivery.id);
      if (deliveryIds.length !== 0) {
        await database.adminInvitationEmailAttempt.deleteMany({
          where: { deliveryId: { in: deliveryIds } },
        });
        await database.adminInvitationEmailDelivery.deleteMany({
          where: { id: { in: deliveryIds } },
        });
      }
      await database.outboxEvent.deleteMany({
        where: {
          aggregateType: 'AdminInvitation',
          aggregateId: { in: invitationIds },
        },
      });
      await database.adminInvitation.deleteMany({
        where: { id: { in: invitationIds } },
      });
    }
    await database.adminSecurityEvent.deleteMany({
      where: { adminUserId: actorId },
    });
    await database.adminUser.delete({ where: { id: actorId } });
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it('delivers from the durable public-reference event exactly once', async () => {
    const invitation = await createPendingInvitation(
      database,
      invitationEmail,
      actorId,
    );
    const provider: jest.Mocked<EmailProvider> = {
      idempotencyRetentionMs: 24 * 60 * 60 * 1000,
      send: jest.fn().mockResolvedValue({
        status: 'SENT',
        providerMessageId: 'message-1',
      }),
    };
    const worker = new AdminInvitationEmailDeliveryService(
      database,
      configuration,
      provider,
      {
        from: 'EduVoucher <admin@example.test>',
        maximumAutomaticAttempts: 5,
        providerName: 'test-email',
        workerId: 'communication-integration-test',
      },
    );

    await expect(worker.processAvailable(1)).resolves.toBe(1);
    await expect(worker.processAvailable(1)).resolves.toBe(0);
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(provider.send.mock.calls[0][0]).toMatchObject({
      from: 'EduVoucher <admin@example.test>',
      to: invitationEmail,
    });
    const event = await database.outboxEvent.findFirstOrThrow({
      where: { aggregateType: 'AdminInvitation' },
      orderBy: { id: 'desc' },
    });
    expect(JSON.stringify(event.payload)).toEqual(
      JSON.stringify({ invitationPublicId: invitation.publicId }),
    );
    expect(event.publishedAt).not.toBeNull();
    await expect(
      database.adminInvitationEmailDelivery.findUnique({
        where: {
          invitationId: (
            await database.adminInvitation.findUniqueOrThrow({
              where: { publicId: invitation.publicId },
              select: { id: true },
            })
          ).id,
        },
        select: { state: true, attemptCount: true, attempts: true },
      }),
    ).resolves.toMatchObject({ state: 'SENT', attemptCount: 1 });
  });

  it('leaves an ambiguous email outcome for manual Super Admin recovery', async () => {
    await createPendingInvitation(database, invitationEmail, actorId);
    const provider: jest.Mocked<EmailProvider> = {
      idempotencyRetentionMs: 24 * 60 * 60 * 1000,
      send: jest.fn().mockResolvedValue({
        status: 'FAILED',
        category: 'UNKNOWN_OUTCOME',
      }),
    };
    const worker = new AdminInvitationEmailDeliveryService(
      database,
      configuration,
      provider,
      {
        from: 'EduVoucher <admin@example.test>',
        maximumAutomaticAttempts: 5,
        providerName: 'test-email',
        workerId: 'communication-integration-test',
      },
    );

    await expect(worker.processAvailable(1)).resolves.toBe(1);
    await expect(worker.processAvailable(1)).resolves.toBe(0);
    expect(provider.send).toHaveBeenCalledTimes(1);
    await expect(
      database.adminInvitationEmailDelivery.findFirst({
        where: { destinationEmail: invitationEmail },
        select: {
          state: true,
          lastFailureCategory: true,
          needsAttentionAt: true,
        },
      }),
    ).resolves.toMatchObject({
      state: 'NEEDS_ATTENTION',
      lastFailureCategory: 'UNKNOWN_OUTCOME',
    });
  });
});

async function createPendingInvitation(
  database: DatabaseClient,
  email: string,
  invitedByAdminUserId: bigint,
): Promise<{ publicId: string }> {
  const publicId = randomUUID();
  const keyring = createSecretKeyring({
    activeKeyId: configuration.secretEncryptionKeyId,
    fingerprintKey: configuration.hmacKey,
    keys: [
      {
        id: configuration.secretEncryptionKeyId,
        material: configuration.secretEncryptionKey,
      },
    ],
  });
  const invitation = await database.adminInvitation.create({
    data: {
      publicId,
      email,
      activeEmail: email,
      role: 'OPERATIONS_ADMIN',
      tokenFingerprint: randomBytes(32).toString('base64url'),
      encryptedToken: encryptSecret(
        randomBytes(32).toString('base64url'),
        keyring,
      ) as never,
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
      invitedByAdminUserId,
    },
    select: { id: true, publicId: true },
  });
  await database.outboxEvent.create({
    data: {
      aggregateType: 'AdminInvitation',
      aggregateId: invitation.id,
      eventType: 'ADMIN_INVITATION_DELIVERY_REQUESTED',
      payload: { invitationPublicId: invitation.publicId },
      dedupeKey: `communication-integration:${invitation.id.toString()}`,
    },
  });
  return { publicId: invitation.publicId };
}
