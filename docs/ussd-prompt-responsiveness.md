# USSD prompt responsiveness

Payments owns prompt dispatch; USSD owns handset messages. Comparison with the
actual Mould backend shows that its payment adapter accepts sessionid/otpcode and
its USSD presenter gives network wallet shortcodes. EduVoucher currently accepts
Nalo sessions and omits those fields. Do not assume Nalo IDs qualify for Moolre's
OTP skip. Mould VotesService.initiateUssdVote explicitly omits the ID for NALO;
EduVoucher's omission matches that path. Mould enqueues prompt dispatch immediately,
whereas EduVoucher previously shared a 30-second loop with payment recovery.

Separate the existing durable prompt consumer from the 30-second payment
recovery loop. Poll prompts every second with bounded batches and one active
cycle per process. Keep PostgreSQL leases, stale-outcome verification, idempotency,
and allocation/payment invariants unchanged. This adds a bounded indexed outbox
query at the configured interval and avoids slow recovery delaying new prompts.
No provider calls enter a transaction. No schema migration or secret changes.

Handset copy says to approve when the prompt arrives and gives the known wallet
menu for the gateway's network. It never asserts that a queued prompt was sent.
Unknown networks get generic wallet-menu instructions. Keep messages within 182
characters and retain the order code and no-repeat-payment instruction.

Runtime setting: USSD_PAYMENT_PROMPT_POLL_INTERVAL_MS (default 1000, 1000-60000).
Monitor dispatch counts, errors and outbox age. Roll back configuration/code if
database polling pressure exceeds budget. A provider requiring OTP remains an
unresolved integration outcome; faster polling cannot fix it.

Acceptance: prompt poller runs independently, cannot overlap itself, skips tests,
stops on shutdown and retries errors; network copy and 182-character budget tested;
typecheck and worker build pass. Existing delivery-service working-tree edits are
unrelated and must be preserved.
