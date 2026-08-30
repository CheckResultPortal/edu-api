# Phase 1g — Voucher Communication Delivery

## Scope and owner

Communication owns durable voucher-delivery obligations, channel state, and
immutable attempt history. Fulfilment remains the only allocation writer;
Communication consumes `VoucherAllocated` and never changes voucher ownership.

## Invariants and privacy

- One `Communication` is created per voucher allocation and has at most one SMS
  and one email delivery, enforced by unique constraints.
- Delivery channels are derived from the immutable order preference: SMS-only,
  email-only, or independent SMS and email obligations.
- The outbox event contains only opaque references. Queue/poller state contains
  delivery IDs and references, never a PIN.
- The encrypted PIN is read and decrypted only after the delivery has an atomic
  processing claim, immediately before the provider call. It is never logged,
  persisted in an attempt, or included in metrics.
- An email delivery generates a PDF and CSV voucher artifact in memory from the
  existing allocation immediately before the provider call. Both attachments
  contain the same serial/PIN pair, are never written to PostgreSQL, Redis,
  BullMQ, logs, audits, or permanent attachment storage, and are discarded with
  the send scope.
- Email text and HTML include the deployment-configured customer support number.
  SMS-only USSD orders do not create email artifacts.

## Transactions, idempotency, and recovery

`VoucherAllocated` is claimed with `FOR UPDATE SKIP LOCKED`; obligation rows and
its `publishedAt` update commit together. Duplicate events converge through the
unique allocation and channel constraints.

Delivery claims use guarded state/lease writes and an immutable attempt number.
Provider calls occur outside transactions. Moolre receives a stable reference
derived from the opaque delivery public ID on every retry. A stale SMS attempt is
reconciled through Moolre SMS status before a retry; an unresolvable outcome is
`UNKNOWN` and cannot be manually resent. Retryable temporary/rate-limit failures
use capped exponential backoff with jitter; other failures need attention.

## Provider configuration and operations

The worker needs `MOOLRE_SMS_VAS_KEY`, an approved
`MOOLRE_SMS_SENDER_ID`, `CUSTOMER_SUPPORT_PHONE`, and the existing Resend
configuration. Credentials and support configuration are deployment-injected
only. Monitor sent, retried, unknown, and needs-attention counts by
channel/provider, along with stale processing leases and pending outbox age.
Validate sender-ID approval and real delivery behavior in Moolre's sandbox
before production rollout.

## Tests and release

Unit coverage verifies Moolre request construction, reference lookup, and
unknown transport outcomes. Existing worker/config tests cover boot and required
configuration. PostgreSQL integration tests remain required before release for
duplicate allocation events, channel-preference variants, concurrent manual
retry, lease expiry/reconciliation, and proof that PINs never enter logs or
queue payloads.

Rollback is application-only before migration. After migration, leave delivery
facts intact and disable the consumer/poller while investigating; never return a
sold voucher to inventory because communication fails.
