import { Injectable } from '@nestjs/common';

import {
  decryptSecret,
  encryptSecret,
  type EncryptedSecret,
} from '@edu-api/encryption';
import { assertValidOutboxEvent } from '@edu-api/outbox';
import type { DatabaseClient } from '@edu-api/database';
import { Prisma } from '../../../../../../generated/prisma/client';

import {
  assertAdminInvitationRole,
  assertUsableAdminInvitation,
  createAdminInvitationToken,
  invitationExpiresAt,
  normalizeAdminInvitationEmail,
} from '../domain/admin-invitation';
import {
  createAdminBearer,
  createTotpProvisioningUri,
  dummyAdminPasswordHash,
  fingerprintAdminBearer,
  generateTotpSecret,
  hashAdminPassword,
  verifyAdminPassword,
  verifyTotpCode,
} from '../domain/admin-credentials';
import {
  AdminAuthenticationError,
  AdminAuthorizationError,
  AdminInvitationError,
  AdminPasswordResetError,
  AdminValidationError,
} from './admin-identity-errors';
import { createAdminIdentityKeyring } from './admin-identity-configuration';
import type {
  AcceptAdministratorInvitationInput,
  AdminIdentityService,
  AdminInvitationResult,
  BeginAdminLoginInput,
  BeginAdminLoginResult,
  CompleteAdminLoginInput,
  CompleteAdminLoginResult,
  CompleteAdminPasswordResetInput,
  InviteAdministratorInput,
  RequestAdminPasswordResetInput,
} from './admin-identity-ports';
import type {
  AdminAuthChallengePurpose,
  AdminIdentityConfiguration,
  AuthenticatedAdmin,
  RequestContext,
} from './administration-types';
import {
  adminChallengeLifetimeMs,
  adminLockDurationMs,
  adminPasswordResetLifetimeMs,
  adminPasswordResetRequestCooldownMs,
  adminSessionLifetimeMs,
  maxFailedAdminAuthenticationAttempts,
} from './administration-types';

type AdminWriteClient = Pick<
  DatabaseClient,
  'adminSecurityEvent' | 'adminUser'
>;

@Injectable()
export class PrismaAdminIdentityService implements AdminIdentityService {
  private readonly keyring;

  constructor(
    private readonly database: DatabaseClient,
    private readonly configuration: AdminIdentityConfiguration,
  ) {
    this.keyring = createAdminIdentityKeyring(configuration);
  }

  async beginLogin(
    input: BeginAdminLoginInput,
    context: RequestContext,
  ): Promise<BeginAdminLoginResult> {
    const email = this.normalizedEmailOrAuthenticationError(input.email);
    const now = new Date();
    let admin = await this.database.adminUser.findUnique({
      where: { email },
      select: {
        id: true,
        isActive: true,
        lockedUntil: true,
        passwordHash: true,
        totpEnabledAt: true,
        totpSecret: true,
      },
    });

    if (
      admin !== null &&
      admin.lockedUntil !== null &&
      admin.lockedUntil <= now
    ) {
      await this.database.adminUser.updateMany({
        where: { id: admin.id, lockedUntil: { lte: now } },
        data: { failedAuthenticationCount: 0, lockedUntil: null },
      });
      admin = { ...admin, lockedUntil: null };
    }

    const passwordIsCorrect = await verifyAdminPassword(
      input.password,
      admin?.passwordHash ?? dummyAdminPasswordHash,
    );
    if (
      admin === null ||
      !admin.isActive ||
      (admin.lockedUntil !== null && admin.lockedUntil > now) ||
      !passwordIsCorrect
    ) {
      if (
        admin !== null &&
        admin.isActive &&
        (admin.lockedUntil === null || admin.lockedUntil <= now) &&
        !passwordIsCorrect
      ) {
        await this.recordAuthenticationFailure(
          admin.id,
          context,
          'ADMIN_LOGIN_FAILED',
        );
      }
      throw new AdminAuthenticationError();
    }

    const purpose: AdminAuthChallengePurpose =
      admin.totpEnabledAt === null || admin.totpSecret === null
        ? 'TOTP_ENROLLMENT'
        : 'TOTP_VERIFICATION';
    const challengeBearer = createAdminBearer();
    const challengeFingerprint = this.fingerprint(
      challengeBearer,
      'admin-auth-challenge',
    );
    const enrollmentSecret =
      purpose === 'TOTP_ENROLLMENT' ? generateTotpSecret() : undefined;
    const enrollmentProvisioningUri =
      enrollmentSecret === undefined
        ? undefined
        : createTotpProvisioningUri({
            accountName: email,
            issuer: 'EduVoucher',
            secret: enrollmentSecret,
          });

    await this.database.$transaction(async (transaction) => {
      const current = await transaction.adminUser.findUnique({
        where: { id: admin.id },
        select: { isActive: true, lockedUntil: true },
      });
      if (
        current === null ||
        !current.isActive ||
        (current.lockedUntil !== null && current.lockedUntil > now)
      ) {
        throw new AdminAuthenticationError();
      }

      await transaction.adminAuthChallenge.updateMany({
        where: { adminUserId: admin.id, purpose, consumedAt: null },
        data: { consumedAt: now },
      });
      if (enrollmentSecret !== undefined) {
        await transaction.adminUser.update({
          where: { id: admin.id },
          data: {
            pendingTotpSecret: asJson(
              encryptSecret(enrollmentSecret, this.keyring),
            ),
          },
        });
      }
      await transaction.adminAuthChallenge.create({
        data: {
          adminUserId: admin.id,
          tokenFingerprint: challengeFingerprint,
          purpose,
          expiresAt: this.after(now, adminChallengeLifetimeMs),
        },
      });
      await transaction.adminUser.update({
        where: { id: admin.id },
        data: { failedAuthenticationCount: 0, lockedUntil: null },
      });
      await transaction.adminSecurityEvent.create({
        data: {
          adminUserId: admin.id,
          eventType: 'ADMIN_LOGIN_CHALLENGE_CREATED',
          correlationId: context.correlationId,
          metadata: { purpose },
        },
      });
    });

    return {
      challengeBearer,
      purpose,
      ...(enrollmentProvisioningUri === undefined
        ? {}
        : { enrollmentProvisioningUri }),
    };
  }

  async completeLogin(
    input: CompleteAdminLoginInput,
    context: RequestContext,
  ): Promise<CompleteAdminLoginResult> {
    const now = new Date();
    const challengeFingerprint = this.fingerprint(
      input.challengeBearer,
      'admin-auth-challenge',
    );
    const challenge = await this.database.adminAuthChallenge.findUnique({
      where: { tokenFingerprint: challengeFingerprint },
      include: {
        adminUser: {
          select: {
            id: true,
            isActive: true,
            lockedUntil: true,
            pendingTotpSecret: true,
            totpSecret: true,
          },
        },
      },
    });
    if (
      challenge === null ||
      challenge.consumedAt !== null ||
      challenge.expiresAt <= now ||
      !challenge.adminUser.isActive ||
      (challenge.adminUser.lockedUntil !== null &&
        challenge.adminUser.lockedUntil > now)
    ) {
      throw new AdminAuthenticationError();
    }

    const encryptedSecret =
      challenge.purpose === 'TOTP_ENROLLMENT'
        ? challenge.adminUser.pendingTotpSecret
        : challenge.adminUser.totpSecret;
    if (!isEncryptedSecret(encryptedSecret)) {
      throw new AdminAuthenticationError();
    }

    let codeIsCorrect = false;
    try {
      codeIsCorrect = verifyTotpCode(
        decryptSecret(encryptedSecret, this.keyring),
        input.code,
        now.getTime(),
      );
    } catch {
      throw new AdminAuthenticationError();
    }
    if (!codeIsCorrect) {
      await this.recordTotpFailure(
        challenge.id,
        challenge.adminUser.id,
        context,
      );
      throw new AdminAuthenticationError();
    }

    const sessionBearer = createAdminBearer();
    const sessionFingerprint = this.fingerprint(sessionBearer, 'admin-session');
    await this.database.$transaction(async (transaction) => {
      const claimed = await transaction.adminAuthChallenge.updateMany({
        where: {
          id: challenge.id,
          tokenFingerprint: challengeFingerprint,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (claimed.count !== 1) {
        throw new AdminAuthenticationError();
      }
      const current = await transaction.adminUser.findUnique({
        where: { id: challenge.adminUser.id },
        select: {
          isActive: true,
          lockedUntil: true,
          pendingTotpSecret: true,
        },
      });
      if (
        current === null ||
        !current.isActive ||
        (current.lockedUntil !== null && current.lockedUntil > now)
      ) {
        throw new AdminAuthenticationError();
      }
      if (
        challenge.purpose === 'TOTP_ENROLLMENT' &&
        !isEncryptedSecret(current.pendingTotpSecret)
      ) {
        throw new AdminAuthenticationError();
      }

      await transaction.adminUser.update({
        where: { id: challenge.adminUser.id },
        data: {
          ...(challenge.purpose === 'TOTP_ENROLLMENT'
            ? {
                pendingTotpSecret: Prisma.DbNull,
                totpEnabledAt: now,
                totpSecret: asJson(current.pendingTotpSecret),
              }
            : {}),
          failedAuthenticationCount: 0,
          lastAuthenticatedAt: now,
          lockedUntil: null,
        },
      });
      await transaction.adminSession.create({
        data: {
          adminUserId: challenge.adminUser.id,
          tokenFingerprint: sessionFingerprint,
          expiresAt: this.after(now, adminSessionLifetimeMs),
        },
      });
      await transaction.adminSecurityEvent.create({
        data: {
          adminUserId: challenge.adminUser.id,
          eventType: 'ADMIN_LOGIN_SUCCEEDED',
          correlationId: context.correlationId,
          metadata: { purpose: challenge.purpose },
        },
      });
    });

    return { sessionBearer };
  }

  async inviteAdministrator(
    actor: AuthenticatedAdmin,
    input: InviteAdministratorInput,
    context: RequestContext,
  ): Promise<AdminInvitationResult> {
    this.assertSuperAdmin(actor);
    const email = this.normalizedInvitationEmail(input.email);
    assertAdminInvitationRole(input.role);
    return this.replaceActiveInvitation({
      actor,
      context,
      email,
      eventType: 'ADMIN_INVITATION_CREATED',
      role: input.role,
    });
  }

  async resendAdministratorInvitation(
    actor: AuthenticatedAdmin,
    invitationPublicId: string,
    context: RequestContext,
  ): Promise<AdminInvitationResult> {
    this.assertSuperAdmin(actor);
    this.assertPublicId(invitationPublicId);
    const now = new Date();
    const previous = await this.database.adminInvitation.findUnique({
      where: { publicId: invitationPublicId },
      select: {
        email: true,
        id: true,
        role: true,
        acceptedAt: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
    if (previous === null) {
      throw new AdminInvitationError('Administrator invitation was not found.');
    }
    if (previous.acceptedAt !== null || previous.revokedAt !== null) {
      throw new AdminInvitationError('Administrator invitation is not usable.');
    }

    const bearer = createAdminInvitationToken();
    const expiresAt = invitationExpiresAt(now);
    const fingerprint = this.fingerprint(bearer, 'admin-invitation');
    const encryptedToken = encryptSecret(bearer, this.keyring);
    return this.database.$transaction(async (transaction) => {
      const revoked = await transaction.adminInvitation.updateMany({
        where: {
          id: previous.id,
          acceptedAt: null,
          revokedAt: null,
        },
        data: {
          activeEmail: null,
          encryptedToken: Prisma.DbNull,
          revokedAt: now,
        },
      });
      if (revoked.count !== 1) {
        throw new AdminInvitationError(
          'Administrator invitation is not usable.',
        );
      }
      const invitation = await transaction.adminInvitation.create({
        data: {
          email: previous.email,
          activeEmail: previous.email,
          role: previous.role,
          tokenFingerprint: fingerprint,
          encryptedToken: asJson(encryptedToken),
          expiresAt,
          invitedByAdminUserId: actor.id,
        },
        select: { id: true, publicId: true },
      });
      await this.createInvitationDeliveryOutboxEvent(transaction, invitation);
      await transaction.adminSecurityEvent.create({
        data: {
          adminUserId: actor.id,
          eventType: 'ADMIN_INVITATION_RESENT',
          correlationId: context.correlationId,
          metadata: { invitationPublicId: invitation.publicId },
        },
      });
      return { publicId: invitation.publicId, expiresAt };
    });
  }

  async revokeAdministratorInvitation(
    actor: AuthenticatedAdmin,
    invitationPublicId: string,
    context: RequestContext,
  ): Promise<void> {
    this.assertSuperAdmin(actor);
    this.assertPublicId(invitationPublicId);
    const now = new Date();
    await this.database.$transaction(async (transaction) => {
      const revoked = await transaction.adminInvitation.updateMany({
        where: {
          publicId: invitationPublicId,
          acceptedAt: null,
          revokedAt: null,
        },
        data: {
          activeEmail: null,
          encryptedToken: Prisma.DbNull,
          revokedAt: now,
        },
      });
      if (revoked.count !== 1) {
        throw new AdminInvitationError(
          'Administrator invitation is not usable.',
        );
      }
      await transaction.adminSecurityEvent.create({
        data: {
          adminUserId: actor.id,
          eventType: 'ADMIN_INVITATION_REVOKED',
          correlationId: context.correlationId,
          metadata: { invitationPublicId },
        },
      });
    });
  }

  async acceptAdministratorInvitation(
    input: AcceptAdministratorInvitationInput,
    context: RequestContext,
  ): Promise<{
    enrollmentBearer: string;
    enrollmentProvisioningUri: string;
  }> {
    const now = new Date();
    const invitationFingerprint = this.fingerprint(
      input.invitationBearer,
      'admin-invitation',
    );
    const invitation = await this.database.adminInvitation.findUnique({
      where: { tokenFingerprint: invitationFingerprint },
      select: {
        acceptedAt: true,
        email: true,
        expiresAt: true,
        id: true,
        revokedAt: true,
        role: true,
      },
    });
    if (invitation === null) {
      throw new AdminInvitationError('Administrator invitation is not usable.');
    }
    try {
      assertUsableAdminInvitation(invitation, now);
    } catch {
      throw new AdminInvitationError('Administrator invitation is not usable.');
    }

    let passwordHash: string;
    try {
      passwordHash = await hashAdminPassword(input.password);
    } catch (error) {
      throw new AdminValidationError(
        error instanceof Error
          ? error.message
          : 'Administrator password is invalid.',
      );
    }
    const enrollmentBearer = createAdminBearer();
    const enrollmentFingerprint = this.fingerprint(
      enrollmentBearer,
      'admin-auth-challenge',
    );
    const totpSecret = generateTotpSecret();

    await this.database.$transaction(async (transaction) => {
      const accepted = await transaction.adminInvitation.updateMany({
        where: {
          id: invitation.id,
          tokenFingerprint: invitationFingerprint,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: {
          acceptedAt: now,
          activeEmail: null,
          encryptedToken: Prisma.DbNull,
        },
      });
      if (accepted.count !== 1) {
        throw new AdminInvitationError(
          'Administrator invitation is not usable.',
        );
      }
      const administrator = await transaction.adminUser.create({
        data: {
          email: invitation.email,
          passwordHash,
          role: invitation.role,
          pendingTotpSecret: asJson(encryptSecret(totpSecret, this.keyring)),
        },
        select: { id: true, publicId: true },
      });
      await transaction.adminAuthChallenge.create({
        data: {
          adminUserId: administrator.id,
          tokenFingerprint: enrollmentFingerprint,
          purpose: 'TOTP_ENROLLMENT',
          expiresAt: this.after(now, adminChallengeLifetimeMs),
        },
      });
      await transaction.adminSecurityEvent.create({
        data: {
          adminUserId: administrator.id,
          eventType: 'ADMIN_INVITATION_ACCEPTED',
          correlationId: context.correlationId,
          metadata: { adminPublicId: administrator.publicId },
        },
      });
    });

    return {
      enrollmentBearer,
      enrollmentProvisioningUri: createTotpProvisioningUri({
        accountName: invitation.email,
        issuer: 'EduVoucher',
        secret: totpSecret,
      }),
    };
  }

  async requestPasswordReset(
    input: RequestAdminPasswordResetInput,
    context: RequestContext,
  ): Promise<void> {
    let email: string;
    try {
      email = normalizeAdminInvitationEmail(input.email);
    } catch {
      return;
    }
    const now = new Date();
    const administrator = await this.database.adminUser.findUnique({
      where: { email },
      select: { id: true, isActive: true },
    });
    if (administrator === null || !administrator.isActive) return;

    const bearer = createAdminBearer();
    const tokenFingerprint = this.fingerprint(bearer, 'admin-password-reset');
    const expiresAt = this.after(now, adminPasswordResetLifetimeMs);
    const encryptedToken = asJson(encryptSecret(bearer, this.keyring));
    await this.database.$transaction(async (transaction) => {
      const current = await transaction.adminUser.findUnique({
        where: { id: administrator.id },
        select: { isActive: true },
      });
      if (current === null || !current.isActive) return;
      const recent = await transaction.adminPasswordReset.findFirst({
        where: {
          adminUserId: administrator.id,
          consumedAt: null,
          revokedAt: null,
          requestedAt: {
            gt: this.after(now, -adminPasswordResetRequestCooldownMs),
          },
        },
        select: { id: true },
      });
      if (recent !== null) return;
      await transaction.adminPasswordReset.updateMany({
        where: {
          adminUserId: administrator.id,
          consumedAt: null,
          revokedAt: null,
        },
        data: { encryptedToken: Prisma.DbNull, revokedAt: now },
      });
      const reset = await transaction.adminPasswordReset.create({
        data: {
          adminUserId: administrator.id,
          tokenFingerprint,
          encryptedToken,
          expiresAt,
        },
        select: { id: true, publicId: true },
      });
      const event = {
        aggregateId: reset.id.toString(),
        aggregateType: 'AdminPasswordReset',
        dedupeKey: `admin-password-reset-email:${reset.id.toString()}`,
        eventType: 'ADMIN_PASSWORD_RESET_DELIVERY_REQUESTED',
        payload: { passwordResetPublicId: reset.publicId },
      } as const;
      assertValidOutboxEvent(event);
      await transaction.outboxEvent.create({
        data: {
          aggregateId: reset.id,
          aggregateType: event.aggregateType,
          dedupeKey: event.dedupeKey,
          eventType: event.eventType,
          payload: event.payload,
        },
      });
      await transaction.adminSecurityEvent.create({
        data: {
          adminUserId: administrator.id,
          eventType: 'ADMIN_PASSWORD_RESET_REQUESTED',
          correlationId: context.correlationId,
          metadata: {},
        },
      });
    });
  }

  async completePasswordReset(
    input: CompleteAdminPasswordResetInput,
    context: RequestContext,
  ): Promise<void> {
    if (!isBearer(input.resetBearer)) throw new AdminPasswordResetError();
    let passwordHash: string;
    try {
      passwordHash = await hashAdminPassword(input.password);
    } catch {
      throw new AdminPasswordResetError();
    }
    const now = new Date();
    const tokenFingerprint = this.fingerprint(
      input.resetBearer,
      'admin-password-reset',
    );
    await this.database.$transaction(async (transaction) => {
      const reset = await transaction.adminPasswordReset.findUnique({
        where: { tokenFingerprint },
        select: { adminUserId: true, id: true },
      });
      if (reset === null) throw new AdminPasswordResetError();
      const consumed = await transaction.adminPasswordReset.updateMany({
        where: {
          id: reset.id,
          tokenFingerprint,
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
          adminUser: { isActive: true },
        },
        data: { consumedAt: now, encryptedToken: Prisma.DbNull },
      });
      if (consumed.count !== 1) throw new AdminPasswordResetError();
      await transaction.adminUser.update({
        where: { id: reset.adminUserId },
        data: {
          failedAuthenticationCount: 0,
          lockedUntil: null,
          passwordChangedAt: now,
          passwordHash,
        },
      });
      await transaction.adminSession.updateMany({
        where: { adminUserId: reset.adminUserId, revokedAt: null },
        data: { revokedAt: now },
      });
      await transaction.adminSecurityEvent.create({
        data: {
          adminUserId: reset.adminUserId,
          eventType: 'ADMIN_PASSWORD_RESET_COMPLETED',
          correlationId: context.correlationId,
          metadata: {},
        },
      });
    });
  }

  async getAuthenticatedAdministrator(
    sessionBearer: string,
  ): Promise<AuthenticatedAdmin | null> {
    if (!isBearer(sessionBearer)) return null;
    const now = new Date();
    const tokenFingerprint = this.fingerprint(sessionBearer, 'admin-session');
    const session = await this.database.adminSession.findUnique({
      where: { tokenFingerprint },
      select: {
        id: true,
        expiresAt: true,
        revokedAt: true,
        adminUser: {
          select: {
            id: true,
            publicId: true,
            role: true,
            isActive: true,
            totpEnabledAt: true,
          },
        },
      },
    });
    if (
      session === null ||
      session.revokedAt !== null ||
      session.expiresAt <= now ||
      !session.adminUser.isActive ||
      session.adminUser.totpEnabledAt === null
    ) {
      return null;
    }
    return {
      id: session.adminUser.id,
      publicId: session.adminUser.publicId,
      role: session.adminUser.role,
      sessionId: session.id,
    };
  }

  async revokeSession(
    sessionBearer: string,
    context: RequestContext,
  ): Promise<void> {
    if (!isBearer(sessionBearer)) return;
    const now = new Date();
    const tokenFingerprint = this.fingerprint(sessionBearer, 'admin-session');
    await this.database.$transaction(async (transaction) => {
      const session = await transaction.adminSession.findUnique({
        where: { tokenFingerprint },
        select: { adminUserId: true, id: true, revokedAt: true },
      });
      if (session === null || session.revokedAt !== null) return;
      const revoked = await transaction.adminSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now },
      });
      if (revoked.count !== 1) return;
      await transaction.adminSecurityEvent.create({
        data: {
          adminUserId: session.adminUserId,
          eventType: 'ADMIN_SESSION_REVOKED',
          correlationId: context.correlationId,
          metadata: {},
        },
      });
    });
  }

  private async replaceActiveInvitation(input: {
    readonly actor: AuthenticatedAdmin;
    readonly context: RequestContext;
    readonly email: string;
    readonly eventType: 'ADMIN_INVITATION_CREATED';
    readonly role: 'SUPER_ADMIN' | 'OPERATIONS_ADMIN';
  }): Promise<AdminInvitationResult> {
    const now = new Date();
    const bearer = createAdminInvitationToken();
    const expiresAt = invitationExpiresAt(now);
    const tokenFingerprint = this.fingerprint(bearer, 'admin-invitation');
    const encryptedToken = encryptSecret(bearer, this.keyring);
    try {
      return await this.database.$transaction(async (transaction) => {
        const existingAdministrator = await transaction.adminUser.findUnique({
          where: { email: input.email },
          select: { id: true },
        });
        if (existingAdministrator !== null) {
          throw new AdminInvitationError('Administrator already exists.');
        }
        const activeInvitation = await transaction.adminInvitation.findUnique({
          where: { activeEmail: input.email },
          select: { id: true, expiresAt: true },
        });
        if (activeInvitation !== null && activeInvitation.expiresAt > now) {
          throw new AdminInvitationError(
            'A pending invitation already exists. Use resend to replace it.',
          );
        }
        if (activeInvitation !== null) {
          await transaction.adminInvitation.updateMany({
            where: {
              id: activeInvitation.id,
              activeEmail: input.email,
              expiresAt: { lte: now },
            },
            data: {
              activeEmail: null,
              encryptedToken: Prisma.DbNull,
              revokedAt: now,
            },
          });
        }
        const invitation = await transaction.adminInvitation.create({
          data: {
            email: input.email,
            activeEmail: input.email,
            role: input.role,
            tokenFingerprint,
            encryptedToken: asJson(encryptedToken),
            expiresAt,
            invitedByAdminUserId: input.actor.id,
          },
          select: { id: true, publicId: true },
        });
        await this.createInvitationDeliveryOutboxEvent(transaction, invitation);
        await transaction.adminSecurityEvent.create({
          data: {
            adminUserId: input.actor.id,
            eventType: input.eventType,
            correlationId: input.context.correlationId,
            metadata: {
              invitationPublicId: invitation.publicId,
              role: input.role,
            },
          },
        });
        return { publicId: invitation.publicId, expiresAt };
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new AdminInvitationError(
          'A pending invitation already exists. Use resend to replace it.',
        );
      }
      throw error;
    }
  }

  private async createInvitationDeliveryOutboxEvent(
    transaction: Pick<DatabaseClient, 'outboxEvent'>,
    invitation: { readonly id: bigint; readonly publicId: string },
  ): Promise<void> {
    const event = {
      aggregateId: invitation.id.toString(),
      aggregateType: 'AdminInvitation',
      dedupeKey: `admin-invitation-delivery:${invitation.id.toString()}`,
      eventType: 'ADMIN_INVITATION_DELIVERY_REQUESTED',
      payload: { invitationPublicId: invitation.publicId },
    } as const;
    assertValidOutboxEvent(event);
    await transaction.outboxEvent.create({
      data: {
        aggregateId: invitation.id,
        aggregateType: event.aggregateType,
        dedupeKey: event.dedupeKey,
        eventType: event.eventType,
        payload: event.payload,
      },
    });
  }

  private async recordTotpFailure(
    challengeId: bigint,
    adminId: bigint,
    context: RequestContext,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const updated = await transaction.adminAuthChallenge.updateMany({
        where: {
          id: challengeId,
          consumedAt: null,
          failedAttemptCount: { lt: maxFailedAdminAuthenticationAttempts },
        },
        data: { failedAttemptCount: { increment: 1 } },
      });
      if (updated.count !== 1) return;
      await this.recordAuthenticationFailureInTransaction(
        transaction,
        adminId,
        context,
        'ADMIN_TOTP_FAILED',
      );
    });
  }

  private async recordAuthenticationFailure(
    adminId: bigint,
    context: RequestContext,
    eventType: 'ADMIN_LOGIN_FAILED' | 'ADMIN_TOTP_FAILED',
  ): Promise<void> {
    await this.database.$transaction((transaction) =>
      this.recordAuthenticationFailureInTransaction(
        transaction,
        adminId,
        context,
        eventType,
      ),
    );
  }

  private async recordAuthenticationFailureInTransaction(
    transaction: AdminWriteClient,
    adminId: bigint,
    context: RequestContext,
    eventType: 'ADMIN_LOGIN_FAILED' | 'ADMIN_TOTP_FAILED',
  ): Promise<void> {
    const now = new Date();
    await transaction.adminUser.updateMany({
      where: {
        id: adminId,
        isActive: true,
        lockedUntil: { lte: now },
      },
      data: { failedAuthenticationCount: 0, lockedUntil: null },
    });
    const incremented = await transaction.adminUser.updateMany({
      where: {
        id: adminId,
        isActive: true,
        failedAuthenticationCount: { lt: 4 },
      },
      data: { failedAuthenticationCount: { increment: 1 } },
    });
    const locked =
      incremented.count === 0
        ? await transaction.adminUser.updateMany({
            where: {
              id: adminId,
              isActive: true,
              failedAuthenticationCount: { gte: 4 },
            },
            data: {
              failedAuthenticationCount: 5,
              lockedUntil: this.after(now, adminLockDurationMs),
            },
          })
        : null;
    if (incremented.count === 0 && locked?.count !== 1) return;
    await transaction.adminSecurityEvent.create({
      data: {
        adminUserId: adminId,
        eventType,
        correlationId: context.correlationId,
        metadata: {},
      },
    });
  }

  private normalizedEmailOrAuthenticationError(email: string): string {
    try {
      return normalizeAdminInvitationEmail(email);
    } catch {
      throw new AdminAuthenticationError();
    }
  }

  private normalizedInvitationEmail(email: string): string {
    try {
      return normalizeAdminInvitationEmail(email);
    } catch (error) {
      throw new AdminValidationError(
        error instanceof Error
          ? error.message
          : 'Administrator email is invalid.',
      );
    }
  }

  private assertSuperAdmin(actor: AuthenticatedAdmin): void {
    if (actor.role !== 'SUPER_ADMIN') throw new AdminAuthorizationError();
  }

  private assertPublicId(value: string): void {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
    ) {
      throw new AdminValidationError(
        'Administrator invitation reference is invalid.',
      );
    }
  }

  private after(now: Date, durationMs: number): Date {
    return new Date(now.getTime() + durationMs);
  }

  private fingerprint(value: string, purpose: string): string {
    return fingerprintAdminBearer(value, this.configuration.hmacKey, purpose);
  }
}

function isBearer(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isEncryptedSecret(value: unknown): value is EncryptedSecret {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.algorithm === 'aes-256-gcm' &&
    typeof candidate.authTag === 'string' &&
    typeof candidate.ciphertext === 'string' &&
    typeof candidate.iv === 'string' &&
    typeof candidate.keyId === 'string'
  );
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}
