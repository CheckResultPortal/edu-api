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

The public write is `POST /v1/orders`. It accepts one product public ID,
quantity, first name, Ghana phone number, customer email address, and an
`Idempotency-Key` header.

For web purchases:

- First name, phone number, and email are all required.
- Delivery is automatically stored as `SMS_AND_EMAIL`.
- The customer does not supply or choose `deliveryPreference` on the web request;
  the backend sets it authoritatively.
- The order purchase channel is recorded as `WEB`.
- Paystack uses the email for payment initialization.

The request does not accept a client price, total, currency, paid state,
delivery preference, internal database ID, or permanent browser credential.
Unknown properties are rejected by the strict request schema.

The response will expose the opaque order reference, purchase channel (`WEB`),
delivery preference (`SMS_AND_EMAIL`), and the authoritative quantity,
unit-price snapshot, total-price snapshot, and currency. It will not expose
internal IDs or create an authorization rule based on a predictable ID.
The customer first name and contact are private operational data and must be
excluded from responses, logs, traces, outbox payloads, metrics labels, and
error details. A later order status read needs a guest-session or equivalent
authorization decision; a bare order reference must not silently become
sufficient authorization.

## Data, constraints, and indexes

The additive migration will introduce `Order` and `OrderItem` with `BIGINT`
internal primary keys. `Order.publicReference` will be unique and opaque.
`OrderItem` will reference both its owning order and the selected Catalog
product, while storing immutable quantity, unit price, total price, and
currency snapshots.

Database checks enforce the approved quantity range of 1-20, positive unit
price and total, GHS currency, bounded normalized first name, Ghana E.164 phone
shape, bounded normalized email, delivery-preference/contact consistency,
contact-anonymization shape, and snapshot arithmetic. Foreign keys must
restrict deletion of referenced products and orders. Indexes must support the
opaque public-reference lookup and later order/payment joins without an
unbounded scan. No order list endpoint is included in this unit.

An `OrderCreated` outbox row will be inserted in the same transaction. Its
versioned payload may contain only the opaque order/product references,
purchase channel, delivery preference, quantity, amount, and currency; it must
not contain first name, phone number, or email. The shared outbox safety guard
validates the event before persistence.

## Transaction, concurrency, and idempotency

Order creation is one short PostgreSQL transaction:

1. Claim the scoped idempotency key with a deterministic request fingerprint,
   including normalized contact and delivery preference.
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

The request fingerprint and Redis rate-limit identifiers use HMAC-SHA-256 with
domain separation and a deployment-injected `ORDER_PRIVACY_HMAC_KEY`; raw or
unkeyed hashes of phone/email-bearing data are not persisted. Expired order
idempotency rows are removed by the worker in bounded indexed batches. Expiry
cleanup never deletes an order or outbox event.

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

Redis rate-limit counters use keyed, domain-separated HMAC identifiers for
IP/phone inputs and expire with the configured window. Redis failure is
fail-open for this transient abuse control so it cannot manufacture or lose an
authoritative order; dependency readiness and alerts must expose the degraded
control. `TRUST_PROXY_HOPS` defaults to zero and must match the deployment's
known reverse-proxy hop count so clients cannot spoof the IP used for limiting.

## Verification and acceptance tests

- Strict validation rejects malformed input, unknown/client-price fields, and
  values outside approved bounds.
- Strict web validation requires first name, phone, and email; rejects a
  client-supplied channel/delivery choice; and derives `WEB` plus
  `SMS_AND_EMAIL`.
- Database constraints accept only the approved USSD contact shapes:
  `SMS_ONLY` without email, `EMAIL_ONLY` with email, and `SMS_AND_EMAIL` with
  email.
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
- First name and Ghana phone number are required for every order.
- Web always requires email and derives `WEB` plus `SMS_AND_EMAIL`; the web
  customer cannot choose a delivery channel.
- Future USSD checkout records `USSD`; the customer chooses `SMS_ONLY`,
  `EMAIL_ONLY`, or `SMS_AND_EMAIL`. Email is collected only for a choice that
  includes email. Phone remains required even for `EMAIL_ONLY` because it is
  the USSD session/customer contact.
- SMS and email later use independent delivery records, attempts, outcomes,
  and retries.
- Raw first name/phone/email contact remains available while an order is pending
  or needs support. It is anonymized 90 days after fulfilment. The later
  fulfilment unit will provide the retention start fact; no creation-time timer
  guesses when fulfilment happened.

Order/payment expiry and the authorization contract for a later public order
status endpoint remain future decisions; neither is part of this creation-only
unit.

## Migration operation

The initial migration is additive. The forward delivery-preference migration
infers only a legacy row's preference from whether it already has email; it does
not invent a first name. Its `NOT VALID` contact constraint still protects all
new or updated rows and may be validated after legacy pre-release rows have
been sourced correctly or anonymized.

`EMAIL_ONLY` is committed in its own migration before any constraint uses the
new PostgreSQL enum value. The next migration adds `purchaseChannel`, accurately
backfills earlier orders as `WEB` because no USSD writer existed, makes the
column required, and intentionally removes the database default so every future
trusted writer must state its source. The web preference constraint is added
`NOT VALID`: it immediately protects all new/updated rows while preserving
historical pre-rule-change SMS-only web rows, and is validated automatically
when no historical exception exists. A following migration replaces the broad
idempotency expiry index with `(scope, expiresAt, id)` for bounded cleanup.

A production rollback must disable order creation while retaining committed
order/outbox/idempotency history; it must not drop live customer or financial
facts. A later approved forward migration may remove unused structures only
after retention and reconciliation review.

## Remaining production-certification dependency

The current shared observability foundation provides structured HTTP/worker
logs and dependency readiness, but it does not yet export the order business
counters/histograms or install the alert rules listed above. Before production
certification, add an approved metrics adapter and alert configuration for order
outcomes/latency, rate-limit rejection, idempotency conflict, database
lock/pool pressure, and old `OrderCreated` outbox events. Do not use phone,
email, first name, client IP, or idempotency key as metric labels. This gap does
not change order correctness, but the unit must not be represented as fully
production-certified until it is closed and failure-tested.
