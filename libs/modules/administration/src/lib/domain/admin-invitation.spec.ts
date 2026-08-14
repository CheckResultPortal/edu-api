import {
  adminInvitationLifetimeMs,
  assertUsableAdminInvitation,
  createAdminInvitationToken,
  assertAdminInvitationRole,
  invitationExpiresAt,
  normalizeAdminInvitationEmail,
} from './admin-invitation';

describe('admin invitation rules', () => {
  it('creates opaque 12-hour invitations for normalized email addresses', () => {
    const now = new Date('2026-08-13T10:00:00.000Z');

    expect(normalizeAdminInvitationEmail(' Admin@Example.COM ')).toBe(
      'admin@example.com',
    );
    expect(invitationExpiresAt(now).getTime() - now.getTime()).toBe(
      adminInvitationLifetimeMs,
    );
    expect(createAdminInvitationToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rejects expired, revoked, and replayed invitations', () => {
    const now = new Date('2026-08-13T10:00:00.000Z');
    const usable = {
      acceptedAt: null,
      revokedAt: null,
      expiresAt: new Date('2026-08-13T10:00:01.000Z'),
    };

    expect(() => assertUsableAdminInvitation(usable, now)).not.toThrow();
    expect(() =>
      assertUsableAdminInvitation({ ...usable, expiresAt: now }, now),
    ).toThrow('expired');
    expect(() =>
      assertUsableAdminInvitation({ ...usable, revokedAt: now }, now),
    ).toThrow('revoked');
    expect(() =>
      assertUsableAdminInvitation({ ...usable, acceptedAt: now }, now),
    ).toThrow('already been accepted');
  });

  it('permits only the two approved administrator roles', () => {
    expect(() => assertAdminInvitationRole('SUPER_ADMIN')).not.toThrow();
    expect(() => assertAdminInvitationRole('OPERATIONS_ADMIN')).not.toThrow();
    expect(() => assertAdminInvitationRole('AUDITOR')).toThrow(
      'role is invalid',
    );
  });
});
