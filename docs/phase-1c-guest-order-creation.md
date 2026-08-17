# Phase 1C: Guest order creation implementation impact

## Scope, owner, and authority

The Orders module will own guest order creation, customer delivery contacts,
order items, and immutable price snapshots. Catalog remains authoritative for
the selected product's current activation, price, and currency. Orders may read
those values through an explicit Catalog query contract, but it must not mutate
Catalog state. Orders never marks a payment successful, creates fulfilment
units, allocates vouchers, or sends customer communications.

This unit implements `INV-API-001` and the Guest Order Creation specification.
It prepares the immutable input required by `INV-PAY-004` and `INV-FUL-001`,
but payment and fulfilment effects remain later units.

## Public contract and privacy boundary

The public write is `POST /v1/orders`. It accepts one product public
ID, quantity, phone number, optional email, and an `Idempotency-Key` header. It
does not accept a client price, total, currency, paid state, internal database
ID, or permanent browser credential. Unknown properties are rejected by the
strict request schema, so a submitted price cannot influence the order.

The response will expose the opaque order reference and the authoritative
quantity, unit-price snapshot, total-price snapshot, and currency. It will not
expose internal IDs or create an authorization rule based on a predictable ID.
The customer contact is private operational data and must be excluded from
logs, traces, outbox payloads, metrics labels, and error details. A later order
status read needs a guest-session or equivalent authorization decision; a bare
order reference must not silently become sufficient authorization.

## Data, constraints, and indexes

The additive migration will introduce `Order` and `OrderItem` with `BIGINT`
internal primary keys. `Order.publicReference` will be unique and opaque.
`OrderItem` will reference both its owning order and the selected Catalog
product, while storing immutable quantity, unit price, total price, and
currency snapshots.

Database checks enforce the approved quantity range of 1-20, positive unit
price and total, GHS currency, Ghana E.164 phone shape, bounded normalized email,
contact-anonymization shape, and snapshot arithmetic. Foreign keys
must restrict deletion of referenced products and orders. Indexes must support
the opaque public-reference lookup and later order/payment joins without an
unbounded scan. No order list endpoint is included in this unit.

An `OrderCreated` outbox row will be inserted in the same transaction. Its
versioned payload may contain only the opaque order/product references,
quantity, amount, and currency; it must not contain phone numbers or email.

## Transaction, concurrency, and idempotency

Order creation is one short PostgreSQL transaction:

1. Claim the scoped idempotency key with a deterministic request fingerprint.
2. Read the active product through the Catalog contract inside the same
   transaction so the accepted price snapshot is coherent.
3. Insert the order, item, and `OrderCreated` outbox row.
4. Complete the idempotency record with the safe order reference and response
   status.

No network call occurs in the transaction. The existing unique
`IdempotencyRecord(scope, key)` constraint arbitrates concurrent duplicates.
The same key and fingerprint returns the original safe result; the same key
with a different fingerprint returns a conflict. A transaction failure rolls
back the idempotency claim, order, item, and event together. Serialization or
connection failure may be retried by the client with the same key.

The command is indexed O(1) database work and O(request size) fingerprinting
time with O(1) application memory. Rate limiting is an abuse control and may
use Redis, but PostgreSQL remains authoritative for the order and idempotency
result.

## Recovery, observability, and security

An application crash before commit leaves no order. A crash after commit leaves
an authoritative order plus its durable outbox event and replayable
idempotency result. An outbox publisher may recover later; this unit has no
external provider call or queue payload containing customer contact data.

Record order-creation success, validation rejection, inactive-product
rejection, idempotency replay/conflict, transaction conflict, latency, and rate
limit rejection using safe route/correlation context only. Alert on elevated
public write error rate, database lock/pool pressure, idempotency conflicts, and
old unpublished `OrderCreated` events. Phone number, email, and idempotency keys
must not be metric labels or structured-log fields.

Redis rate-limit counters use hashes of IP/phone inputs and expire with the
configured window. Redis failure is fail-open for this transient abuse control
so it cannot manufacture or lose an authoritative order; dependency readiness
and alerts must expose the degraded control. `TRUST_PROXY_HOPS` defaults to zero
and must match the deployment's known reverse-proxy hop count so clients cannot
spoof the IP used for limiting.

## Verification and acceptance tests

- Strict validation rejects malformed input, unknown/client-price fields, and
  values outside approved bounds.
- No login or permanent browser API key is required.
- Inactive or missing products cannot create an order.
- A Catalog price change after creation does not alter an existing snapshot.
- Same idempotency key and payload returns the original order under sequential
  retries and a concurrent request race.
- Same idempotency key with a different payload returns a conflict.
- A failed transaction leaves no partial order, item, idempotency completion,
  or outbox event.
- Public references are opaque and internal IDs/contact data are absent from
  the public response and durable event.
- Unit, real-PostgreSQL integration, public API end-to-end, security,
  concurrency/idempotency, migration, lint, typecheck, architecture, and build
  checks pass.

## Approved Phase 1 policies

- A guest order contains 1-20 vouchers for one product.
- Ghana phone numbers are stored canonically as E.164 `+233` numbers.
- Web checkout accepts only products priced in GHS.
- An idempotency key remains replayable for 24 hours. After expiry, reusing the
  key is a new request; clients must generate a new key for every intentional
  purchase.
- Initial configurable limits are 30 requests per 10 minutes for one client IP
  and 10 requests per 10 minutes for one normalized phone number.
- Raw phone/email contact remains available while an order is pending or needs
  support. It is anonymized 90 days after fulfilment. The later fulfilment unit
  will provide the retention start fact; no creation-time timer guesses when
  fulfilment happened.

Order/payment expiry and the authorization contract for a later public order
status endpoint remain future decisions; neither is part of this creation-only
unit.

## Migration operation

The migration is additive. Forward deployment applies the `Order` and
`OrderItem` tables before enabling the public route. A production rollback must
disable order creation while retaining committed order/outbox/idempotency
history; it must not drop live customer or financial facts. A later approved
forward migration may remove unused structures only after retention and
reconciliation review.
