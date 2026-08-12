# Phase 0 product foundation

## Scope and owner

This Phase 0 unit owns reusable platform primitives only:

- Transactional Outbox record and event contract
- Idempotency record and deterministic request fingerprinting
- Authenticated encryption and HMAC fingerprint primitives for future voucher PIN handling
- Module-boundary skeleton and configuration decision register

It owns no voucher, product, order, payment, fulfilment, communication, stock, or result-checking business record.

## Standards and compliance boundary

- PostgreSQL and Prisma are the authoritative persistence standard.
- Domain state change and durable outbox insert occur in one short PostgreSQL transaction. External publication is asynchronous and idempotent.
- Idempotency records use a unique scope/key constraint. A future application command must atomically claim the record, compare a deterministic request fingerprint, and store a safe response reference.
- Voucher-secret primitives use AES-256-GCM authenticated encryption and HMAC-SHA-256 fingerprints. Plain PINs are never valid outbox, idempotency, queue, log, trace, audit, or response data.

The outbox is indexed by availableAt and id for pending rows; workers can claim due work in bounded keyset batches. Request fingerprinting is O(payload size) time and O(nesting depth) auxiliary memory. Encryption/fingerprinting is O(secret length) time and O(1) application-level memory beyond cryptographic buffers.

## Constraints and failure behavior

Outbox dedupeKey is unique when supplied. Idempotency scope/key is unique, and completed records require a completion time. A duplicate key with a different request fingerprint is a conflict; duplicate key behavior is implemented by the owning command, never a controller shortcut.

The outbox record remains durable through Redis or worker outages. The eventual publisher and recovery sweeper are intentionally deferred until a first domain event exists; no provider/network call is permitted in the creating transaction.

## Open policy decisions

The following must be selected before their adapters/configuration are implemented:

1. Admin identity provider/session model, roles, MFA and audit retention.
2. Public browser origins, rate-limit budgets, and abuse policy.
3. Web payment provider, webhook verification policy, currency, and refund policy.
4. Moolre account/credential provisioning and USSD/SMS callback contract.
5. Email provider, sender identity, delivery retention, and retry limits.
6. Deployment secret manager and encryption key rotation procedure.

No placeholder secrets or guessed provider policy is committed.

## Acceptance and verification

- Prisma validates the schema and migration contains constraints/indexes.
- Encryption round trips with the active and previous key, rejects malformed ciphertext, and produces stable keyed fingerprints.
- Request fingerprints are deterministic across object key order and reject invalid/cyclic external values.
- Outbox contracts reject unsafe/invalid shape before persistence adapters are introduced.
- Lint, tests, build, Nx sync, and formatting pass.
