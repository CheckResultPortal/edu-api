# Phase 1I: Admin operations and reconciliation implementation impact

## Scope and ownership

Administration owns authenticated operational views and audited commands. It
does not become the writer of orders, payments, inventory, fulfilment, or
communication records. Its query facade composes those PostgreSQL facts for
support and operations without mutating them. Communication remains the owner
of manual delivery retry. Reconciliation owns mismatch detection and finding
history and never repairs business history silently.

The unit provides:

- sales and fulfilment dashboard totals for a bounded time window;
- cursor-paginated order investigation with exact search by order reference,
  normalized phone/email, payment reference, or voucher serial;
- one protected order detail containing guest contact and the complete known
  order, payment, fulfilment, allocation, and channel-delivery timestamps;
- cursor-paginated product inventory, paid backlog, communication delivery,
  attempt-history, stock-alert, and administration-audit views;
- atomically claimed, idempotent manual retry for a safe
  `NEEDS_ATTENTION` communication delivery, with an admin security event in
  the same transaction as the retry state change; and
- persisted reconciliation findings for the approved inventory, paid
  fulfilment, and sold-voucher ownership equations.

## Invariants, privacy, and authorisation

- Voucher PINs, encrypted PIN material, fingerprints, provider credentials,
  checkout access codes, webhook signatures, and idempotency keys are never
  returned by an admin view or written to an audit/finding payload.
- Voucher serial numbers may be shown only inside the protected order and
  inventory investigation views. PINs remain masked by omission.
- Guest first name, phone, and email are returned only from TOTP-authenticated
  Admin API endpoints. They are not logged, used as metric labels, or written
  into audit metadata.
- `SUPER_ADMIN` and `OPERATIONS_ADMIN` may read operational views and request
  a safe delivery retry. A retry of `UNKNOWN`, `SENT`, active, or automatically
  retrying work is rejected without changing the allocation or voucher.
- The same retry idempotency key and delivery returns the original result. The
  same key with a different delivery is a conflict. Concurrent double-clicks
  have one database winner.
- Search is exact after canonical normalization. No unbounded contact scan or
  fuzzy enumeration endpoint is introduced.

## Data, indexes, and complexity

Operational lists are bounded to 100 rows and use keyset cursors derived from
opaque public references or timestamp/public-reference pairs. New indexes
cover exact normalized phone/email lookup, order lifecycle pagination,
payment-reference investigation, waiting backlog, communication state, and
reconciliation-finding pagination.

Dashboard queries require an explicit bounded window of at most 366 days and
return aggregate counts/sums only. Order detail is bounded by the launch
quantity maximum of 20 fulfilment units and two communication channels per
allocation. Reconciliation runs indexed aggregate/anti-join queries and stores
only safe counts/references.

`ReconciliationFinding` uses a stable fingerprint as the idempotency boundary.
Repeated detection updates `lastDetectedAt` and `occurrenceCount`; disappearance
marks a finding resolved without deleting the historical finding. Finding
state never changes an order, payment, fulfilment unit, allocation, or voucher.

## Transactions, recovery, and observability

Read views do not use external providers or hold long write transactions.
Manual retry claims the scoped idempotency key, validates the existing
allocation-backed delivery, changes only the Communication-owned delivery
state, writes the admin audit event, and completes the idempotency record in one
short serializable transaction. The worker later decrypts the same allocation
at send time.

Reconciliation runs in bounded worker cycles. Each finding upsert/resolve pass
is recoverable from PostgreSQL and safe to repeat. A failed scan leaves
business history unchanged and is retried. Monitor dashboard query latency,
manual retry outcomes, open findings by type/severity, oldest open finding,
paid backlog age, delivery needs-attention, and outbox age.

## Acceptance coverage

- Unauthenticated requests cannot read guest contact, sales, inventory,
  attempts, audit data, or findings.
- Lists are bounded, cursor-paginated, and use only opaque cursors.
- Exact search resolves every approved key without returning PINs.
- Order detail exposes every available lifecycle timestamp and independent SMS
  and email delivery histories.
- Manual retry is atomic, audited, idempotent, and cannot retry an ambiguous
  provider outcome or allocate another voucher.
- Injected inventory, paid-fulfilment, and sold-without-allocation mismatches
  create explicit findings; a clean rerun resolves findings without modifying
  source facts.
- OpenAPI, unit, PostgreSQL integration, E2E, architecture, lint, typecheck,
  build, and migration checks pass.
