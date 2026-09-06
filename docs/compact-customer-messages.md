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

Scheduling is now event-triggered; see [event-driven worker processing](event-driven-worker-processing.md) for recovery settings and rollout. The earlier one-second polling change is superseded.
