# Phase 1D: Web payment and fulfilment-unit implementation impact

## Scope, ownership, and authority

Payments owns provider attempts, authenticated provider-event receipts,
canonical attempt state, and the exactly-once application of one successful
payment to an order. Fulfilment owns the durable units owed to a paid customer.
Orders remains authoritative for guest contact and immutable price/item
snapshots. Paystack is the first web provider behind the `PaymentProvider` port;
provider request, authentication, response, and status semantics stay inside
its adapter.

This unit implements `INV-PAY-001` through `INV-PAY-004` and `INV-FUL-001`.
It does not allocate vouchers, reject paid work when stock is empty, send
customer communication, or implement Moolre USSD. Those later units consume
the durable payment/fulfilment facts introduced here.

## Public contract, authorisation, and privacy

`POST /v1/orders/:orderPublicReference/payments` initializes a Paystack web
attempt. It requires an `Idempotency-Key` and accepts no client-controlled
amount, currency, email, provider reference, callback URL, paid status, or
provider credential. The server loads the web order's snapshotted GHS total and
email through an Orders-owned query contract, generates a unique provider
reference, and returns only the opaque payment reference and Paystack checkout
values needed by the browser.

`POST /v1/payments/paystack/webhook` authenticates the exact raw request bytes
with Paystack's HMAC-SHA512 signature before parsing or persistence. The
frontend redirect/callback is never payment proof. A valid but irrelevant
event is acknowledged without a business effect. A valid `charge.success`
event is accepted only when `data.status` is explicitly `success` and its
reference, amount, and currency match the stored expected attempt. A missing,
malformed, or non-success provider status creates no payment or fulfilment
effect even when the event name is `charge.success`.

The initialization endpoint intentionally performs no sensitive order-status
read and exposes no order contact. Its opaque order reference plus endpoint/IP
rate control is the current guest boundary. A future customer status/details
endpoint still requires an approved guest-session authorization design; this
unit does not make a bare order reference authorization for customer data.

Provider secrets, webhook signatures, customer contact, checkout access codes,
and idempotency keys are excluded from logs, outbox payloads, metrics labels,
and errors. The Paystack secret is deployment-injected and never exposed to the
browser or committed.

## State and business interpretation

Each intentional initialization is a separate payment attempt with canonical
state `INITIALIZING`, `PENDING`, `UNKNOWN`, `SUCCEEDED`, or `FAILED`.
`UNKNOWN` means provider outcome requires verification; it is not treated as a
safe failure. Provider-native statuses are retained as bounded support data but
are interpreted only in the adapter.

An order has at most one `PaymentApplication`. The first verified successful
attempt wins that unique row and creates the order item's fulfilment units.
Another genuinely successful attempt remains recorded as `SUCCEEDED`, is
marked `ADDITIONAL_SUCCESS`, and emits a needs-reconciliation event; it creates
no units. Automatic refund behavior is deliberately not invented because no
approved refund policy exists.

Each fulfilment unit represents one paid voucher obligation. For quantity N,
ordinals 1 through N are created once. `allocatedAt IS NULL` means the unit is
waiting, including when stock is empty. This unit does not add a reservation or
another voucher lifecycle state.

## Data, constraints, and indexes

`PaymentAttempt`, `PaymentProviderEvent`, `PaymentApplication`, and
`FulfilmentUnit` use `BIGINT` internal primary keys. Public payment and
fulfilment references are UUIDs. Provider/reference uniqueness, one application
per order and attempt, and `UNIQUE(orderItemId, ordinal)` enforce the critical
deduplication rules in PostgreSQL.

Checks enforce positive GHS expected amounts, bounded provider-native fields,
safe SHA-256 event fingerprints, state/checkout consistency, positive
fulfilment ordinals, and paid-before-allocation time ordering. A composite
fulfilment foreign key prevents its product from differing from the owning
order item. Hot indexes support provider-reference lookup, bounded recovery
claiming, order-attempt support queries, and future waiting-unit FIFO selection
by `paidAt, id`; no hot path scans an unbounded table.

Only a SHA-256 fingerprint and normalized safe event fields are stored for a
provider callback. The raw provider body and HMAC signature are not persisted.

## Transactions, concurrency, idempotency, and complexity

Initialization first runs a short transaction that claims the scoped
idempotency key, reads the web order through the Orders contract, and creates
an `INITIALIZING` attempt. The Paystack network call then runs outside every
database transaction. A second short transaction records the checkout result
and completes the idempotency record. The same key/payload replays the original
attempt; the same key for a different order is a conflict. A new key may create
another attempt for the same unpaid order. Once an order has an applied
payment, further initialization is rejected.

Successful webhook or verification processing uses one short transaction:

1. Insert the deduplicated provider-event receipt.
2. Lock and validate the matching attempt and expected amount/currency.
3. Record the provider-confirmed success.
4. Atomically claim the order's unique payment application.
5. If this attempt wins, create exactly N fulfilment units through the
   Fulfilment-owned transactional writer and insert `PaymentSucceeded` in the
   transactional outbox.
6. If another attempt already won, mark this attempt for reconciliation and
   insert one `PaymentAdditionalSuccessDetected` outbox event.

Database uniqueness arbitrates callback storms and competing successful
attempts. Callback work is O(quantity), where the approved quantity maximum is
20, and uses O(quantity) bounded application memory. Initialization and event
lookups are indexed O(1) operations.

## Recovery, failure behavior, events, and observability

Invalid signatures never touch authoritative state. Reference, amount, or
currency mismatches are durably rejected and create no success effect.
Initialization timeouts and malformed/5xx provider replies are recorded as
unknown rather than retried blindly with the same reference. Clients may begin
a separate intentional attempt with a new key.

The worker claims a bounded set of pending/unknown attempts with PostgreSQL
leases and `FOR UPDATE SKIP LOCKED`, calls Paystack verification outside the
claim transaction, and feeds verified success through the same canonical
application path as the webhook. Non-success/temporary results release the
lease and schedule bounded exponential recovery; exhausted attempts are marked
for attention rather than guessed successful or harmless. A crash after the
success transaction leaves payment, fulfilment units, event receipt, and
outbox fact committed together. Outbox publication and future allocation can
recover independently of Redis.

The safe durable events are versioned `PaymentSucceeded` and
`PaymentAdditionalSuccessDetected`; their payloads contain opaque references,
quantity, amount, currency, and paid time only. They contain no contact,
provider authorization values, signature, key, or voucher secret.

Before production certification, metrics/alerts must cover initialization and
verification outcomes, invalid signatures and mismatches, successful payments,
additional successes, pending/unknown age, recovery exhaustion, outbox age,
waiting-unit count/age, and database lock/pool pressure. The current structured
request/worker logging and durable needs-attention facts preserve safe
operational evidence, but the shared metrics exporter/alert installation is a
known platform gap.

## Acceptance and security tests

- Strict initialization input rejects a body, malformed references, missing or
  conflicting idempotency keys, non-web orders, and already-paid orders.
- The provider adapter sends backend-authoritative email, GHS amount, generated
  reference, and configured callback URL without exposing the secret.
- Provider timeout becomes `UNKNOWN`; no network call runs in a transaction.
- Invalid signatures and malformed events produce no payment effect.
- Signed reference, amount, and currency mismatches create no fulfilment units.
- The same signed success delivered sequentially or concurrently up to 1,000
  times creates one application, exactly N units, and one success outbox event.
- Two successful attempts for one order create one unit set; the other is
  retained and marked for reconciliation.
- Recovery verification uses the same success path and a bounded leased scan.
- Real-PostgreSQL integration, provider contract, HTTP/OpenAPI, unit,
  concurrency/idempotency, migration, lint, typecheck, architecture, and build
  checks pass.

## Migration and unresolved policy

The migration is additive. A rollback must first disable payment
initialization/webhook/recovery processing and retain financial, fulfilment,
provider-event, and outbox history. It must not drop or rewrite live payment
facts. A later forward migration may remove unused structures only after
retention and reconciliation review.

No automatic refund or operator resolution policy for an additional genuine
payment has been approved. This implementation therefore records and alerts on
that condition without issuing a refund or duplicating fulfilment.
