# Six-digit customer order codes

User-approved change: a unique six-digit customer code plus the checkout phone
number identifies an order. Orders owns the code; the UUID remains the public
API identity and payment attempts retain their unique provider references.
Short codes never prove payment and never authorize payment initialization.

Generate random codes from 100000 through 999999, enforce uniqueness and format
in PostgreSQL, and retry collisions at most three times with the existing short
order transaction. Exhausted retries return temporary unavailability; no fallback
may reuse another order's code. This namespace has a hard lifetime capacity of
900,000 orders. A wider code needs a product decision before capacity is reached.
Track code-allocation failures and review capacity during reconciliation.

Existing orders retain UUID lookup; the additive nullable column avoids a large
backfill and preserves idempotency replay. New orders receive codes in the same
transaction as their idempotency record and outbox event. No payment, allocation,
delivery ownership, amount/currency checks or durable events change.

Lookup accepts UUID, six-digit code, or Paystack EDU UUID reference with the
phone number and existing IP/phone rate limits. Retrieval by short code requires
phone even when email is also supplied; delivery goes only to the saved email.
Lookup uses indexed unique code/reference filters and bounded result sizes.
The callback page falls back from empty reference to trxref and requires phone
verification. Backend webhook/recovery remains authoritative for payment state.

Deploy the additive migration/backend before the storefront. Old clients and
old orders continue using UUIDs. Roll back application code without dropping the
column or destroying codes. Tests cover validation, phone authorization,
collision retry, idempotency replay, callback fallback and production builds.
