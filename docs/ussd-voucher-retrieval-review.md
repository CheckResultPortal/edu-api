# USSD voucher retrieval review and proposal

Status: reviewed proposal; SMS retrieval policy is not approved or implemented.

Follow-up: the home/menu/support fixes, shared stored-email retrieval flow, and
worker error handling are implemented in
[USSD retrieval implementation](ussd-retrieval-implementation.md). The findings
below record the state at review time. SMS copies remain outside this change.

## Current implementation

The working changes add a welcome message, category-menu support option, and
public API support-phone configuration/deployment wiring. USSD still implements
only purchase states and pending-payment recovery. There is no retrieval menu,
retrieval session state, order-status query wiring, or retrieval command wiring.

Web retrieval uses the Orders status/access query and Communication's durable
`VoucherRetrievalEmailDelivery`/`VoucherRetrievalEmailAttempt` records. Its poller
is registered in the existing worker process. It sends only to the stored email
after access, verified payment, and allocation checks. SMS-only orders cannot
use this email retrieval path. This review inspected backend code, not a separate
web frontend repository or a live provider deployment.

## Findings

1. The welcome/category menu truncates at 182 characters. Four accepted
   40-character category names produce 238 characters: the fourth category and
   support option disappear. Prefixing invalid-input text reduces the budget
   further. Reserve navigation space and paginate whole rows instead of slicing
   the assembled menu.
2. The public configuration and USSD factory silently substitute
   `+233000000000`. This can publish a non-working support number. Require a real
   deployment value when advertising support, and confirm whether that number
   actually supports WhatsApp before promising it.
3. Category lookup precedes support handling and terminates when no categories
   exist. A retrieval entry placed in that handler would become unavailable when
   the catalog is empty, and support currently depends on a successful catalog
   query. A separate home screen should be independent of catalog availability.
4. The email retrieval worker wraps artifact generation, provider send, and
   success persistence in one catch that records `PERMANENT`. If send succeeds
   but success persistence fails, a subsequent successful failure write records
   a definite failure despite an uncertain delivery outcome. Split pre-send
   errors from send/post-send uncertainty; preserve unknown outcomes for safe
   recovery. Do not copy this catch into a new SMS worker.
5. There are no dedicated retrieval-worker or retrieval-command tests in the
   Communication test files inspected. Existing passing tests do not establish
   retrieval concurrency, crash recovery, or duplicate-send safety.

## Proposed customer flow

```text
Welcome to EduVoucherStore
1. Buy voucher
2. Retrieve voucher
0. Support
```

Retrieve asks for the opaque order reference and combines it with the canonical
phone from the provider session. Reuse `findByPhoneAndReference` for safe status.
Show waiting/payment states without promising a resend. For a paid, fully
allocated order, confirm an intentional copy request, persist it, then end the
session with a queued acknowledgement. Acknowledgement is not delivery proof.

Recommended SMS policy, pending approval: resend the same purchased vouchers to
the phone stored on the order, matching the session phone. Never accept an
alternate destination, display PINs on USSD, collect a new email implicitly, or
allocate replacement vouchers. Existing stored-email retrieval remains usable
for orders with email through the same application authorization boundary.

The existing reference is a UUID. Reference entry is the smallest change that
preserves the documented authorization rule, but is cumbersome on a handset.
Phone-only recent-order lists or a shorter recovery code require a separately
approved access rule; do not silently weaken reference-plus-contact verification.
Lost-reference customers use support until that policy is approved.

## Implementation impact and direct contracts

- USSD owns home/reference/confirmation session states and provider translation.
  Orders owns reference/contact lookup and paid/allocated eligibility.
  Communication owns copy requests, attempts, delivery, and recovery. Inventory
  and Fulfilment ownership and allocation constraints remain unchanged.
- Extract the existing web controller's authorization and request orchestration
  behind an application contract shared with USSD. Do not call an HTTP controller
  internally or invoke the email queue writer without access validation. Make
  reference-plus-contact mandatory in the shared contract; the current access
  query type permits both optional contacts to be omitted by an internal caller.
- Prefer extending retrieval obligations to explicit channels with independent
  delivery/attempt records while preserving existing email rows and references.
  For SMS, track each allocated voucher separately so a partially completed
  multi-voucher order does not resend successful items. Prepare an additive
  migration design before choosing table changes; do not reuse initial-delivery
  records by resetting their history or overload an email destination field.
- Persist the intentional request and its obligations with idempotency in one
  short PostgreSQL transaction. Use unique request/channel/allocation identities
  and stable provider references. Duplicate callbacks after Redis/session expiry
  must still resolve to the original durable request. New intentional requests
  are distinct from retries of the same request.
- Existing database polling can dispatch durable pending records without a new
  queue or worker process. If using queue notifications, write a transactional
  outbox event alongside obligations; payloads contain only references.
- Queries are bounded to the existing order quantity maximum and worker batch
  limits. Index request identity, due deliveries, and processing lease recovery.
  Use atomic claims across workers; decrypt only at send time; make no provider
  calls in database transactions.
- Apply server-side per-order and per-phone resend controls that cannot be bypassed
  by changing idempotency keys. Numeric cooldown/daily limits and charging policy
  require product decisions. Account for many callers sharing the gateway IP.
- Confirm deployed gateway authentication before trusting a handset identity.
  The code currently uses Nalo for USSD and Moolre for collection/SMS, whereas the
  local planning ADR names Moolre USSD. Record/locate approval for that provider
  change and verify the gateway's documented authentication contract. USERID
  matching alone must not be assumed to prove phone ownership.
- Classify send uncertainty separately, reconcile using verified provider
  capabilities, and retain needs-attention history. Expose queued/sent/unknown
  retrieval status and safe admin recovery without revealing PINs. Monitor
  request rejection/rate limits, pending age, channel outcomes, and stale leases.
- Forward migration must preserve email history; rollback should disable new
  retrieval entry/dispatch while retaining obligations and allocation ownership.

## Acceptance and validation

Existing USSD/config suites passed: 53 tests. A deterministic menu-length check
reproduced loss of the support option. No live SMS, production data mutation, or
retrieval integration validation was performed.

Required implementation coverage: home screen with empty catalog; longest menu
rows and pagination; wrong reference/phone; SMS-only orders; unpaid/waiting orders;
destination immutability; duplicate callbacks; session expiry; concurrent workers;
same allocated credentials across attempts; partial multi-voucher sends;
send-success/database-failure; unknown provider outcomes; resend limits; and no
PIN in USSD responses, queues, logs, or audit events.

## Decisions needed

Approve SMS copies to the original order phone (or restrict launch to stored-email
copies/status), confirm the real support contact and WhatsApp availability, and
set resend cooldown/daily limits and whether intentional copies are free. Keep
reference-plus-session-phone authorization unless a replacement rule is approved.
