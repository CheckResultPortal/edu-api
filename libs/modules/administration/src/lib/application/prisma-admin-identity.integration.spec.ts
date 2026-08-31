import { createHmac, randomUUID } from 'node:crypto';

import { createPrismaClient, type DatabaseClient } from '@edu-api/database';

import { hashAdminPassword } from '../domain/admin-credentials';
import { AdminInvitationError } from './admin-identity-errors';
import { PrismaAdminInvitationDeliveryReader } from './admin-invitation-delivery';
import { PrismaAdminIdentityService } from './prisma-admin-identity.service';
import type {
  AdminIdentityConfiguration,
  AuthenticatedAdmin,
} from './administration-types';

const databaseUrl = process.env.ADMIN_IDENTITY_TEST_DATABASE_URL;
const describeWithDatabase =
  databaseUrl === undefined ? describe.skip : describe;
const testPassword = 'a-long-test-only-admin-password';
const configuration: AdminIdentityConfiguration = {
  applicationOrigin: 'https://admin.example.test',
  hmacKey: Buffer.alloc(32, 11),
  secretEncryptionKeyId: 'test-v1',
  secretEncryptionKey: Buffer.alloc(32, 12),
};

describeWithDatabase('PrismaAdminIdentityService (PostgreSQL)', () => {
  let database: DatabaseClient;
  let identity: PrismaAdminIdentityService;
  let actor: AuthenticatedAdmin;
  let actorEmail: string;
  let invitationEmail: string;

  beforeAll(async () => {
    database = await createPrismaClient({ DATABASE_URL: databaseUrl });
    identity = new PrismaAdminIdentityService(database, configuration);
  });

  beforeEach(async () => {
    const suffix = randomUUID();
    actorEmail = `admin-${suffix}@integration.test`;
    invitationEmail = `operations-${suffix}@integration.test`;
    const administrator = await database.adminUser.create({
      data: {
        email: actorEmail,
        passwordHash: await hashAdminPassword(testPassword),
        role: 'SUPER_ADMIN',
      },
      select: { id: true, publicId: true },
    });
    actor = {
      id: administrator.id,
      publicId: administrator.publicId,
      role: 'SUPER_ADMIN',
      sessionId: BigInt(0),
    };
  });

  afterEach(async () => {
    const passwordResets = await database.adminPasswordReset.findMany({
      where: { adminUserId: actor.id },
      select: { id: true },
    });
    if (passwordResets.length !== 0) {
      await database.outboxEvent.deleteMany({
        where: {
          aggregateType: 'AdminPasswordReset',
          aggregateId: { in: passwordResets.map((reset) => reset.id) },
        },
      });
      await database.adminPasswordReset.deleteMany({
        where: { id: { in: passwordResets.map((reset) => reset.id) } },
      });
    }
    const invitations = await database.adminInvitation.findMany({
      where: {
        OR: [{ email: invitationEmail }, { invitedByAdminUserId: actor.id }],
      },
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
    const administratorIds = [
      actor.id,
      ...(
        await database.adminUser.findMany({
          where: { email: invitationEmail },
          select: { id: true },
        })
      ).map((administrator) => administrator.id),
    ];
    await database.adminSession.deleteMany({
      where: { adminUserId: { in: administratorIds } },
    });
    await database.adminAuthChallenge.deleteMany({
      where: { adminUserId: { in: administratorIds } },
    });
    await database.adminSecurityEvent.deleteMany({
      where: { adminUserId: { in: administratorIds } },
    });
    await database.adminUser.deleteMany({
      where: { id: { in: administratorIds } },
    });
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it('requires TOTP before issuing a session, then rejects a replayed challenge', async () => {
    const started = await identity.beginLogin(
      { email: actorEmail, password: testPassword },
      { correlationId: 'integration-login' },
    );

    expect(started.purpose).toBe('TOTP_ENROLLMENT');
    expect(started.enrollmentProvisioningUri).toMatch(/^otpauth:\/\/totp\//);
    const enrollmentSecret = new URL(
      started.enrollmentProvisioningUri as string,
    ).searchParams.get('secret') as string;
    await expect(
      database.adminSession.count({ where: { adminUserId: actor.id } }),
    ).resolves.toBe(0);

    const completed = await identity.completeLogin(
      {
        challengeBearer: started.challengeBearer,
        code: testTotpCode(enrollmentSecret),
      },
      { correlationId: 'integration-totp' },
    );
    await expect(
      identity.getAuthenticatedAdministrator(completed.sessionBearer),
    ).resolves.toMatchObject({ id: actor.id, role: 'SUPER_ADMIN' });
    await expect(
      identity.completeLogin(
        {
          challengeBearer: started.challengeBearer,
          code: testTotpCode(enrollmentSecret),
        },
        { correlationId: 'integration-replay' },
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  it('allows exactly one concurrent acceptance of an invitation', async () => {
    const invitation = await identity.inviteAdministrator(
      actor,
      { email: invitationEmail, role: 'OPERATIONS_ADMIN' },
      { correlationId: 'integration-invite' },
    );
    const delivery = await new PrismaAdminInvitationDeliveryReader(
      database,
      configuration,
    ).getPendingInvitation(invitation.publicId);
    expect(delivery).not.toBeNull();
    const token = new URL(delivery?.invitationUrl as string).searchParams.get(
      'token',
    ) as string;

    const results = await Promise.allSettled([
      identity.acceptAdministratorInvitation(
        { invitationBearer: token, password: testPassword },
        { correlationId: 'integration-accept-a' },
      ),
      identity.acceptAdministratorInvitation(
        { invitationBearer: token, password: testPassword },
        { correlationId: 'integration-accept-b' },
      ),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    await expect(
      database.adminUser.count({ where: { email: invitationEmail } }),
    ).resolves.toBe(1);
  });

  it('allows only one concurrent pending invitation for an email address', async () => {
    const results = await Promise.allSettled([
      identity.inviteAdministrator(
        actor,
        { email: invitationEmail, role: 'OPERATIONS_ADMIN' },
        { correlationId: 'integration-invite-a' },
      ),
      identity.inviteAdministrator(
        actor,
        { email: invitationEmail, role: 'OPERATIONS_ADMIN' },
        { correlationId: 'integration-invite-b' },
      ),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    await expect(
      database.adminInvitation.count({ where: { email: invitationEmail } }),
    ).resolves.toBe(1);
  });

  it('invalidates the old bearer before a resend creates a new invitation', async () => {
    const invitation = await identity.inviteAdministrator(
      actor,
      { email: invitationEmail, role: 'OPERATIONS_ADMIN' },
      { correlationId: 'integration-invite' },
    );
    const reader = new PrismaAdminInvitationDeliveryReader(
      database,
      configuration,
    );
    const beforeResend = await reader.getPendingInvitation(invitation.publicId);
    const oldToken = new URL(
      beforeResend?.invitationUrl as string,
    ).searchParams.get('token') as string;

    const resent = await identity.resendAdministratorInvitation(
      actor,
      invitation.publicId,
      { correlationId: 'integration-resend' },
    );
    await expect(
      identity.acceptAdministratorInvitation(
        { invitationBearer: oldToken, password: testPassword },
        { correlationId: 'integration-old-bearer' },
      ),
    ).rejects.toBeInstanceOf(AdminInvitationError);
    await expect(
      reader.getPendingInvitation(resent.publicId),
    ).resolves.not.toBeNull();
  });

  it('consumes a password reset once and revokes every existing session', async () => {
    await database.adminSession.create({
      data: {
        adminUserId: actor.id,
        tokenFingerprint: `test-session-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await identity.requestPasswordReset(
      { email: actorEmail },
      { correlationId: 'integration-password-reset-request' },
    );
    const reset = await database.adminPasswordReset.findFirstOrThrow({
      where: { adminUserId: actor.id },
      select: { publicId: true },
    });
    const delivery = await new PrismaAdminInvitationDeliveryReader(
      database,
      configuration,
    ).getPendingPasswordReset(reset.publicId);
    const bearer = new URL(
      delivery?.passwordResetUrl as string,
    ).searchParams.get('token') as string;
    const newPassword = 'a-new-long-test-only-admin-password';

    const results = await Promise.allSettled([
      identity.completePasswordReset(
        { password: newPassword, resetBearer: bearer },
        { correlationId: 'integration-password-reset-a' },
      ),
      identity.completePasswordReset(
        { password: newPassword, resetBearer: bearer },
        { correlationId: 'integration-password-reset-b' },
      ),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    await expect(
      database.adminSession.count({
        where: { adminUserId: actor.id, revokedAt: null },
      }),
    ).resolves.toBe(0);
    await expect(
      identity.beginLogin(
        { email: actorEmail, password: newPassword },
        { correlationId: 'integration-password-reset-login' },
      ),
    ).resolves.toMatchObject({ purpose: 'TOTP_ENROLLMENT' });
  });
});

function testTotpCode(secret: string, now = Date.now()): string {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac('sha1', decodeBase32(secret))
    .update(bytes)
    .digest();
  const offset = digest[digest.length - 1] & 15;
  const value =
    ((digest[offset] & 127) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(value % 1_000_000).padStart(6, '0');
}

function decodeBase32(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const character of value) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
