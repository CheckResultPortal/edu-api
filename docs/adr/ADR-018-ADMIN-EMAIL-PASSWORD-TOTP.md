# ADR-018: Admin email/password with mandatory TOTP

## Status

Accepted.

## Decision

Use local administrator email/password authentication with mandatory TOTP MFA,
opaque database-backed sessions, and the two roles `SUPER_ADMIN` and
`OPERATIONS_ADMIN`.

Only the first Super Admin may be created by the local/deployment script. Every
later administrator is admitted by a 12-hour invitation created or resent by an
authenticated Super Admin.

## Consequences

- Customer APIs remain guest based; no browser application secret is introduced.
- Passwords use memory-hard Argon2id; TOTP secrets use existing authenticated
  encryption primitives; session and challenge bearers are stored only as HMAC
  fingerprints.
- Catalog writes and later imports can use a consistent protected identity and
  audit context.
- TOTP recovery and additional admin roles require an explicit future design,
  not a bypass.
- Invitation delivery is a Communication-module request. It uses the
  canonical `EmailProvider` port; the initial adapter is Resend. Provider
  errors are normalized and the provider may be replaced without changing
  invitation, MFA, session, or RBAC rules.
- Each invite/resend creates a transactional-outbox event containing only the
  invitation public reference. Communication owns its email delivery and
  immutable attempt records; it decrypts the invitation bearer only at the
  send edge. Temporary failures retry within bounded configured limits, while
  unknown outcomes require Super Admin recovery through a fresh resend.
