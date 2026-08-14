import { decryptSecret, type EncryptedSecret } from '@edu-api/encryption';
import type { DatabaseClient } from '@edu-api/database';

import { createAdminIdentityKeyring } from './admin-identity-configuration';
import type { AdminIdentityConfiguration } from './administration-types';

export interface AdminInvitationDelivery {
  readonly email: string;
  readonly invitationId: bigint;
  readonly invitationPublicId: string;
  readonly invitationUrl: string;
}

/**
 * This read facade is the only cross-module contract needed by Communication.
 * It decrypts the bearer only at the delivery edge and never puts it in queues,
 * logs, audit events, or an outbox payload.
 */
export class PrismaAdminInvitationDeliveryReader {
  private readonly keyring;

  constructor(
    private readonly database: DatabaseClient,
    configuration: AdminIdentityConfiguration,
  ) {
    this.keyring = createAdminIdentityKeyring(configuration);
    this.applicationOrigin = new URL(configuration.applicationOrigin);
  }

  private readonly applicationOrigin: URL;

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
