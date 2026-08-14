export type AdminRole = 'SUPER_ADMIN' | 'OPERATIONS_ADMIN';

export type AdminAuthChallengePurpose = 'TOTP_ENROLLMENT' | 'TOTP_VERIFICATION';

export interface AuthenticatedAdmin {
  readonly id: bigint;
  readonly publicId: string;
  readonly role: AdminRole;
  readonly sessionId: bigint;
}

export interface AdminIdentityConfiguration {
  readonly applicationOrigin: string;
  readonly hmacKey: Uint8Array;
  readonly secretEncryptionKeyId: string;
  readonly secretEncryptionKey: Uint8Array;
}

export interface RequestContext {
  readonly correlationId: string;
}

export const maxFailedAdminAuthenticationAttempts = 5;
export const adminLockDurationMs = 15 * 60 * 1000;
export const adminSessionLifetimeMs = 12 * 60 * 60 * 1000;
export const adminChallengeLifetimeMs = 10 * 60 * 1000;
export const outboxLeaseDurationMs = 60 * 1000;
