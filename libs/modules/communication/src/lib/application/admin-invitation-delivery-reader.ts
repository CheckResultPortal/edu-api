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
