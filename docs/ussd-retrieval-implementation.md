# USSD stored-email retrieval implementation impact

USSD owns the home/reference/confirmation conversation. Orders exposes shared
guest retrieval authorization and rate limiting to web and USSD. Communication
retains its existing durable email requests and worker. This implements the
documented reference-plus-contact policy: USSD supplies its canonical session
phone and the customer supplies an opaque order reference. Fully paid/allocated
orders with stored email can request copies; SMS-only orders receive status and
support guidance. No new SMS-copy policy, destination change, charge, or numeric
resend limit is invented.

Home/support remain available without catalog queries. Category/product menus
paginate bounded lists with whole navigation rows within 182 characters. Support
is advertised only when a non-placeholder contact is configured; no unverified
WhatsApp claim is made. Redis stores only transient references and request keys.

The shared application service revalidates contact, payment, and allocation
eligibility before each write, and reuses existing rate budgets and PostgreSQL
idempotency. Repeated confirmation uses one stable key; a lost session cannot
issue a write directly. No allocation/inventory writes, schema/index migrations,
new events, or external calls in transactions are introduced. Existing bounded
worker polling recovers durable obligations after crashes. Provider-send and
post-send uncertainty cannot be downgraded to a definite failure; persistence
failure leaves the lease available for existing UNKNOWN recovery.

The retrieval worker now validates the encryption module's `authTag` field
instead of the nonexistent `tag` field, so valid encrypted credentials reach
the send edge. A regression test encrypts a synthetic PIN with the real keyring
and verifies that the artifact generator receives the original credentials.

Acceptance tests cover empty catalog, long menus, missing support contact,
reference/contact validation, status-only SMS orders, eligible email requests,
duplicate confirmation, session expiry, cancellation, rate limits, destination
immutability, provider throws, and send-success/persistence-failure. Run targeted
unit/integration tests as available, typecheck/build, lint/module-boundary rules,
and formatting. Existing safe retrieval poller metrics/logs remain in use.

Rollback is application-only; retain all retrieval obligations and attempts.
SMS copies, lost-reference recovery, and provider authentication changes remain
separate decisions. Live provider sends are not part of local verification.

## Operations and verification

Restart the public API and worker after updating. USSD option 2 asks for the full
order reference, then offers an email copy only when eligible. Option 1 preserves
the category/product purchase flow with two menu rows per page; 9 moves to the
next page and 0 returns home. Set `CUSTOMER_SUPPORT_PHONE` on the public API to a
real contact to expose Support; blank and placeholder values hide that option.
The existing web retrieval HTTP request and response contracts are unchanged.

All three application builds and targeted typechecks passed. USSD, Orders,
Communication, configuration and worker unit tests cover the new flow and error
handling. Lint includes Nx module-boundary checks. PostgreSQL integration tests
require `COMMUNICATION_TEST_DATABASE_URL`/`ORDERS_TEST_DATABASE_URL`; neither is
configured locally, and Docker's engine is not running, so database verification
and live delivery remain unverified here.
