# ADR-016: Phase 0 platform primitives

## Status

Accepted.

## Decision

Use PostgreSQL-backed OutboxEvent and IdempotencyRecord tables as reusable platform records. Domain modules will own their state transitions but insert durable outbox events in the same short transaction. Use AES-256-GCM with versioned key identifiers for voucher secret encryption and HMAC-SHA-256 for duplicate fingerprints.

## Consequences

- Redis/BullMQ cannot be the only source of a durable event or idempotency decision.
- A provider call cannot occur inside the creating transaction.
- Every future outbox payload is safe references/metadata only.
- Voucher inventory is the first consumer of encryption; no PIN table is created in Phase 0.
- Admin authentication, providers, CORS, rate budgets, and secret-manager policy remain explicit open decisions.
