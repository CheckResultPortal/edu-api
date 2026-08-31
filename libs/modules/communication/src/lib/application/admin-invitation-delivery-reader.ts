import type { DatabaseClient } from '@edu-api/database';
import {
  createSecretKeyring,
  decryptSecret,
  type EncryptedSecret,
} from '@edu-api/encryption';

export interface AdminInvitationDeliveryConfiguration {
  readonly applicationOrigin: string;
  readonly hmacKey: Uint8Array;
  readonly secretEncryptionKeyId: string;
  readonly secretEncryptionKey: Uint8Array;
}

export interface AdminInvitationDelivery {
  readonly email: string;
  readonly invitationId: bigint;
  readonly invitationPublicId: string;
  readonly invitationUrl: string;
}

export interface AdminPasswordResetDelivery {
  readonly email: string;
  readonly passwordResetId: bigint;
  readonly passwordResetPublicId: string;
  readonly passwordResetUrl: string;
}

/** Reads the administration-owned invitation through a narrow delivery edge. */
export class AdminInvitationDeliveryReader {
  private readonly applicationOrigin: URL;
  private readonly keyring;

  constructor(
    private readonly database: DatabaseClient,
    configuration: AdminInvitationDeliveryConfiguration,
  ) {
    this.applicationOrigin = new URL(configuration.applicationOrigin);
    this.keyring = createSecretKeyring({
      activeKeyId: configuration.secretEncryptionKeyId,
      fingerprintKey: configuration.hmacKey,
      keys: [
        {
          id: configuration.secretEncryptionKeyId,
          material: configuration.secretEncryptionKey,
        },
      ],
    });
  }

  async getPendingInvitation(
    invitationPublicId: string,
    now = new Date(),
  ): Promise<AdminInvitationDelivery | null> {
    const invitation = await this.database.adminInvitation.findUnique({
      where: { publicId: invitationPublicId },
      select: {
        acceptedAt: true,
        email: true,
        encryptedToken: true,
        expiresAt: true,
        id: true,
        publicId: true,
        revokedAt: true,
      },
    });
    if (
      invitation === null ||
      invitation.acceptedAt !== null ||
      invitation.revokedAt !== null ||
      invitation.expiresAt <= now ||
      !isEncryptedSecret(invitation.encryptedToken)
    ) {
      return null;
    }
    const invitationUrl = new URL(
      '/admin/invitations/accept',
      this.applicationOrigin,
    );
    invitationUrl.searchParams.set(
      'token',
      decryptSecret(invitation.encryptedToken, this.keyring),
    );
    return {
      email: invitation.email,
      invitationId: invitation.id,
      invitationPublicId: invitation.publicId,
      invitationUrl: invitationUrl.toString(),
    };
  }

  async getPendingPasswordReset(
    passwordResetPublicId: string,
    now = new Date(),
  ): Promise<AdminPasswordResetDelivery | null> {
    const reset = await this.database.adminPasswordReset.findUnique({
      where: { publicId: passwordResetPublicId },
      select: {
        adminUser: { select: { email: true, isActive: true } },
        consumedAt: true,
        encryptedToken: true,
        expiresAt: true,
        id: true,
        publicId: true,
        revokedAt: true,
      },
    });
    if (
      reset === null ||
      !reset.adminUser.isActive ||
      reset.consumedAt !== null ||
      reset.revokedAt !== null ||
      reset.expiresAt <= now ||
      !isEncryptedSecret(reset.encryptedToken)
    ) {
      return null;
    }
    const passwordResetUrl = new URL(
      '/admin/password-reset',
      this.applicationOrigin,
    );
    passwordResetUrl.searchParams.set(
      'token',
      decryptSecret(reset.encryptedToken, this.keyring),
    );
    return {
      email: reset.adminUser.email,
      passwordResetId: reset.id,
      passwordResetPublicId: reset.publicId,
      passwordResetUrl: passwordResetUrl.toString(),
    };
  }
}

export function decodeCommunicationKey(value: string): Uint8Array {
  const key = Buffer.from(value, 'base64url');
  if (key.byteLength !== 32) {
    throw new Error('Expected a 32-byte base64url key.');
  }
  return key;
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
