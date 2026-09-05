# Phase 1J: Guest order retrieval implementation impact

## Scope and owner

Orders owns the read-only customer order-retrieval query. It composes the
order's immutable product snapshot with Payment, Fulfilment, and Communication
facts; it does not write payment, allocation, voucher, or communication state.

The public API exposes an order-status lookup and queues a secure email resend
of already fulfilled vouchers. Customer accounts are not introduced.

USSD now exposes the same stored-email copy capability from its Retrieve voucher
home-menu option. It uses the canonical session phone plus the order reference
and shares the Orders application authorization/rate-limit service with web.
SMS-only orders receive status/support guidance; SMS copies are not enabled.
See [implementation and operations](ussd-retrieval-implementation.md).

## Guest authorisation and privacy

The status lookup accepts a canonical Ghana phone number plus either:

- the matching email address, which lists a bounded set of matching orders; or
- an opaque order reference, for SMS-only USSD orders that have no email.

Retrieval requires the order's opaque reference plus either the matching phone
number or the matching email address. Email or order reference alone is never
sufficient to expose order data or voucher credentials. A resend is sent only
to the email already stored on that order; a caller cannot redirect it by
supplying a different address. SMS-only USSD orders can show their status but
cannot receive an email copy until an approved email-collection and
verification policy is added.

The lookup returns a safe lifecycle summary only: product name, price snapshot,
payment/fulfilment/delivery state, and counts. It never returns email, phone,
first name, provider credentials, internal IDs, or PINs. A no-match response
is deliberately generic so that the endpoint does not confirm whether a
contact exists in the system.

The resend request creates a durable email-delivery obligation only after the
matching order is fully allocated. The worker decrypts each PIN only while it
generates the existing in-memory PDF attachments immediately before sending to
the order's stored email. PINs are never persisted, logged, queued, audited,
or returned by JSON.

## State interpretation

- `PAYMENT_PENDING`: payment has not yet been verified.
- `PAYMENT_FAILED`: the latest known attempt failed and no successful payment
  was applied.
- `WAITING_FOR_STOCK`: verified payment created units but at least one unit has
  not been allocated.
- `DELIVERY_IN_PROGRESS`: all units are allocated and delivery obligations are
  still being processed.
- `DELIVERY_ISSUE`: a delivery is `UNKNOWN` or `NEEDS_ATTENTION`.
- `DELIVERED`: every existing delivery obligation is `SENT`.

These values describe state only. They do not alter the payment truth,
fulfilment FIFO, allocation, or communication retry behaviour.

## Data, performance, and recovery

The status read uses a canonical Ghana phone number plus either the matching
email address or the unique public reference.
The resend request uses a new durable, idempotent email-delivery record so
delivery state and attempts remain separate from the original initial-delivery
records. Email generation loads one order and its at-most-20 allocated units,
so memory and time are bounded by the existing order quantity limit.

The status and resend endpoints are rate limited by IP and a privacy-safe
contact identifier using domain-separated HMAC Redis keys. Redis remains
fail-open as a transient abuse control; PostgreSQL remains authoritative. The
resend request writes its idempotency record and durable delivery obligation in
one transaction; the provider call runs only in the worker and outside database
transactions.

## Acceptance criteria

- No account/login is needed.
- A status lookup cannot be performed with email or order reference alone.
- A resend cannot be requested until payment is verified and every unit is
  allocated.
- Paid orders waiting for stock return a clear waiting status.
- Voucher PDFs are sent only to the order's stored email and never appear in
  logs, queue data, or JSON responses.
- Existing web and USSD delivery preferences continue to control initial SMS
  and email delivery independently.
