# USSD prompt responsiveness

Payments owns prompt dispatch; USSD owns handset messages. Comparison with the
actual Mould backend shows that its payment adapter accepts sessionid/otpcode and
its USSD presenter gives network wallet shortcodes. EduVoucher currently accepts
Nalo sessions and omits those fields. Do not assume Nalo IDs qualify for Moolre's
OTP skip. Mould VotesService.initiateUssdVote explicitly omits the ID for NALO;
EduVoucher's omission matches that path. Mould enqueues prompt dispatch immediately,
whereas EduVoucher previously shared a 30-second loop with payment recovery.

Prompt dispatch is separate from payment recovery and now subscribes to committed
UssdPaymentPromptRequested notifications. Bounded batches continue immediately
until drained. PostgreSQL leases, stale-outcome verification, idempotency and
payment invariants remain unchanged. The notification migration is required.
No provider calls enter a transaction and no secret configuration changes.

Handset copy says to approve when the prompt arrives and gives the known wallet
menu for the gateway's network. It never asserts that a queued prompt was sent.
Unknown networks get generic wallet-menu instructions. Keep messages within 182
characters and retain the order code and no-repeat-payment instruction.

The earlier polling setting is removed. Prompt requests now wake the worker after commit; see [event-triggered processing](event-driven-worker-processing.md).
Monitor dispatch counts, errors and outbox age. Roll back configuration/code if
database pressure exceeds budget. A provider requiring OTP remains an
unresolved integration outcome; immediate dispatch cannot fix it.

Acceptance: prompt consumer runs independently, cannot overlap itself, skips tests,
stops on shutdown and retries errors; network copy and 182-character budget tested;
typecheck and worker build pass.
