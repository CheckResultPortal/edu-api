import { randomBytes } from 'node:crypto';

export const adminInvitationLifetimeMs = 12 * 60 * 60 * 1000;

export interface InvitationState {
  readonly acceptedAt: Date | null;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export function createAdminInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

export function invitationExpiresAt(now: Date): Date {
  return new Date(now.getTime() + adminInvitationLifetimeMs);
}

export function normalizeAdminInvitationEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('Administrator invitation email is invalid.');
  }
  return normalized;
}

export function assertAdminInvitationRole(
  role: string,
): asserts role is 'SUPER_ADMIN' | 'OPERATIONS_ADMIN' {
  if (role !== 'SUPER_ADMIN' && role !== 'OPERATIONS_ADMIN') {
    throw new Error('Administrator invitation role is invalid.');
  }
}

export function assertUsableAdminInvitation(
  invitation: InvitationState,
  now: Date,
): void {
  if (invitation.acceptedAt !== null) {
    throw new Error('Administrator invitation has already been accepted.');
  }
  if (invitation.revokedAt !== null) {
    throw new Error('Administrator invitation has been revoked.');
  }
  if (invitation.expiresAt.getTime() <= now.getTime()) {
    throw new Error('Administrator invitation has expired.');
  }
}
