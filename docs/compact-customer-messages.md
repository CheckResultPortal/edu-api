# Compact customer messages

USSD owns the final handset screen; Communication owns SMS. Shorten the approval
instruction while retaining amount, order code, network-menu guidance and the
no-repeat-payment instruction. SMS contains the catalog product name, order reference, serial,
PIN and configured checker URL. Do not infer WASSCE/BECE from arbitrary names or
truncate voucher credentials. Email retains its order reference and privacy text.

No schema, payment, authorization, transaction, allocation, retry or provider
contracts change. Formatting is linear in bounded existing fields, exclusively
at send time; no PIN logging or persistence is added. Missing URLs are omitted.
Long credentials or product names may require multipart SMS; never truncate them.
Validate exact credential preservation and optional URL rendering, USSD flow tests,
typecheck and lint. No migration; rollback restores copy only.

Allocation and delivery now default to one-second polling. Bounded batches,
non-overlap guards, leases and idempotency are unchanged. Under idle healthy
conditions this reduces combined scheduling wait from roughly ten seconds to
two seconds maximum; processing and provider time are additional.
This is not an end-to-end latency guarantee. Allocation's shared recovery loop
also runs more often: monitor DB query load, pool pressure and backlog age.
Existing production overrides still apply. Set worker runtime variables
VOUCHER_ALLOCATION_POLL_INTERVAL_MS=1000 and
VOUCHER_DELIVERY_POLL_INTERVAL_MS=1000. Restore both to 5000 if DB pressure rises.
No migration is required. Payment verification and retry backoff are unchanged.
The production log attachment is missing, so confirmation/provider latency is
unmeasured. Compare approval, verified payment, allocation and channel acceptance
timestamps with safe order references; never log voucher credentials.
