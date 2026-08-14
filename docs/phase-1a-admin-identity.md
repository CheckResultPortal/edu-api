# Phase 1A prerequisite: Admin identity and access

## Scope and decision

The Administration module owns administrator identities, email/password login,
mandatory TOTP second factor, opaque server-side sessions, and the two approved
roles:

- `SUPER_ADMIN`: manages administrator access and all privileged operations.
- `OPERATIONS_ADMIN`: manages catalogue and day-to-day inventory operations;
  it cannot manage administrator identities or provider/security configuration.

This is a direct prerequisite to the Catalog admin write surface. It does not
create customer accounts, change the guest public flow, or expose any voucher
PIN.

## Security controls

- Passwords are salted and derived with Argon2id (64 MiB memory, three passes,
  one lane); plaintext passwords never persist or enter logs/audit data.
- TOTP uses RFC 6238, a 30-second period, six digits, and a cryptographically
  random secret. A pending secret and enabled secret are AES-256-GCM encrypted
  using the configured versioned key. The raw secret is returned only once to
  the authenticated administrator during enrollment and is never logged.
- A first login creates a short-lived, single-use enrollment challenge. Existing
  administrators receive a short-lived, single-use TOTP verification challenge.
  A session is issued only after TOTP succeeds.
- Sessions use a 32-byte opaque bearer stored only in an HttpOnly, Secure,
  SameSite=Strict cookie. PostgreSQL stores an HMAC fingerprint, never the
  bearer. Sessions expire after 12 hours and are revocable.
- Five failed password or TOTP attempts lock an account for 15 minutes. Errors
  do not disclose whether an email address exists.
- Security-critical admin activity records a safe, non-secret security event
  with actor, correlation ID, action, and timestamp.

## Data, transactions, and performance

`AdminUser.email`, session-token fingerprint, and challenge-token fingerprint
are unique. Active-session and usable-challenge partial indexes support point
lookups. Each login/TOTP transition updates one identity/challenge row and
creates at most one session/security event in a short PostgreSQL transaction.
No network call occurs in a transaction.

Password derivation is intentionally expensive and bounded: three Argon2id
passes and O(64 MiB) memory per attempted password. It must run at bounded server
concurrency. Session/challenge lookup is indexed O(log n) database work and
O(1) application memory.

## Operations and recovery

Only an existing Super Admin can invite, resend, revoke, or change the role of
an administrator. Invitations last 12 hours. Resending invalidates the previous
link before a new 12-hour link is created. Repository access, an API deployment,
and an Operations Admin must never create an administrator.

Invitation email delivery is delegated to Communication through the canonical
`EmailProvider` port. Resend is the initial adapter, not an Administration
dependency: it receives a provider-neutral delivery request and returns a
canonical success or failure category. The invitation event/job contains only
the invitation public reference; its bearer token is never placed in an outbox,
queue, log, or audit event.

Creating or resending an invitation writes its invitation row, audit event, and
`ADMIN_INVITATION_DELIVERY_REQUESTED` outbox event in one PostgreSQL
transaction. Communication claims a bounded, ordered batch with `FOR UPDATE
SKIP LOCKED`, then creates one email-delivery record and immutable attempt rows.
It decrypts the bearer only immediately before handing the acceptance URL to the
email adapter. The network request runs outside the transaction.

Known temporary and rate-limit failures use exponential backoff with jitter.
`ADMIN_INVITATION_EMAIL_MAX_ATTEMPTS` is a deployment-controlled operational
ceiling (default 5; range 1–20). Authentication, malformed-request, permanent,
and unknown provider outcomes go directly to `NEEDS_ATTENTION`; they are never
automatically resent. A crashed attempt may reuse its provider idempotency key
only during the adapter's declared idempotency window. After that window it is
also needs-attention. Manual recovery is a Super Admin resend, which revokes the
old bearer and creates a fresh 12-hour invitation; it never resends an unknown
old email blindly.

The worker is configured with `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, the shared
admin HMAC/encryption keys, bounded batch size, and polling interval through
deployment secret/configuration injection. None belongs in a committed `.env`
file. It emits structured delivery-cycle logs without recipients, bearer URLs,
provider credentials, or other secrets. Monitor delivery sent/retry/failure/
needs-attention counts, pending outbox age, worker throughput, and stale
processing records; alert on needs-attention growth or an old outbox backlog.

The sole exception is `pnpm admin:create-super-admin`, a local/deployment
command for the first Super Admin. It requires database access and runtime-only
email/password values, refuses once a Super Admin exists, records an audit event,
and leaves TOTP enrollment mandatory at first login. It is never an HTTP route.
Lost-TOTP recovery is a future Super Admin workflow with a separate audited
decision; no insecure bypass is included here.

Track login successes/failures, lockouts, TOTP failures, active sessions, and
expired/consumed challenge rejection. Alert on failed-login or lockout spikes.

## Acceptance

- Passwords, raw TOTP secrets, raw session/challenge tokens, and encryption
  keys are absent from persistence/log/audit payloads.
- A password alone cannot create an authenticated admin session.
- Challenge replay, expired challenges, role escalation, and revoked/expired
  sessions are rejected.
- Operations Admin cannot manage administrator identity; protected Catalog
  writes require either approved role and record actor/correlation context.
- A real PostgreSQL integration suite covers single-use TOTP, challenge replay,
  concurrent invitation create/accept races, resend invalidation, durable
  outbox delivery, and unknown-email-outcome recovery. Run it against a
  migration-current disposable database by setting
  `ADMIN_IDENTITY_TEST_DATABASE_URL` and `COMMUNICATION_TEST_DATABASE_URL`.
