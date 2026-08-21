# Phase 1F: Paid backlog and restock drain implementation impact

## Scope, ownership, and invariants

Fulfilment owns the paid backlog drain and remains the sole permanent writer
of voucher allocations. Voucher Inventory continues to own batch activation,
voucher eligibility, and the `AVAILABLE -> SOLD` transition. Activation emits
the existing version-1 `VoucherStockAdded` transactional-outbox event; a
Fulfilment worker consumes it and drains at most `RESTOCK_DRAIN_CHUNK_SIZE`
waiting units for that product. The implementation enforces `INV-FUL-002`
through `INV-FUL-005`, `INV-VOU-001` through `INV-VOU-005`, and
`INV-STK-003`.

Paid units with `allocatedAt = NULL` remain durable obligations. A short
transaction locks those units in `(paidAt, id)` order, locks eligible vouchers
in `(batchId, voucherId)` order, pairs only the locked rows, updates vouchers
to `SOLD`, bulk-creates allocations, marks units allocated, and bulk-creates
private `VoucherAllocated` outbox events. If no voucher is eligible, the
transaction commits no allocation or voucher-state change. Communication is
still not involved in allocation.

## Privacy, contracts, data, and concurrency

This is worker-only; it adds no public or admin route and no new customer
authorisation surface. Event validation accepts only the version-1 public batch
and product UUIDs plus a positive quantity. PINs, serials, contacts, encrypted
credentials, and event payloads are not logged or put in new queue data.

Migration `20260821100000_restock_backlog_drain` adds the singleton
`FulfilmentBacklogSweepState` cursor and
`FulfilmentUnit_waiting_productPublicId_fifo_idx`. The existing partial
`FulfilmentUnit_waiting_fifo_idx` selects one waiting product at a time without
scanning fulfilment history; the new partial index resolves a stock event's
public product reference to its oldest waiting unit. The cursor is locked with
`FOR UPDATE SKIP LOCKED`, so only one recovery sweep cursor advances at a time;
normal allocation workers retain their row-level `SKIP LOCKED` concurrency.

Each event and recovery product transaction is O(K) time and O(K) memory for
K = `RESTOCK_DRAIN_CHUNK_SIZE`, bounded to 500. Selection uses the partial
indexes; voucher, allocation, fulfilment-unit, and outbox writes are bulk
writes. Unique voucher and fulfilment-unit allocation constraints remain the
final duplicate defence. The stock event is marked published in the same
transaction as the chunk it triggers, so a crash rolls back both the chunk and
event completion.

## Recovery, operations, and deployment

The worker also performs a periodic, durable-cursor sweep of waiting products.
It advances past zero-stock products and restarts from the beginning after one
complete pass, so recovery does not depend on an event being delivered. A
stalled stock-event claim is recovered by its lease; transient event failures
back off with jitter and eventually move to needs-attention. A zero-stock
result is a successful event consumption, not a failure or a payment reversal.

Relevant worker settings are `RESTOCK_DRAIN_OUTBOX_BATCH_SIZE`,
`RESTOCK_DRAIN_CHUNK_SIZE`, `RESTOCK_DRAIN_RECOVERY_PRODUCT_BATCH_SIZE`,
`RESTOCK_DRAIN_POLL_INTERVAL_MS`, `RESTOCK_DRAIN_LEASE_MS`,
`RESTOCK_DRAIN_MAX_ATTEMPTS`, `RESTOCK_DRAIN_RETRY_BASE_DELAY_MS`, and
`RESTOCK_DRAIN_RETRY_MAX_DELAY_MS`. The poller logs only safe counts and an
event's internal reference; dashboards/alerts must track waiting count and
age, allocation throughput/duration, stock-event/outbox age,
needs-attention, and database lock pressure.

Deploy the migration before worker code. Rollback after live allocations must
be forward-only: stop the restock worker, retain allocations/outbox history,
and remove only the cursor/index after a reviewed migration. Do not delete or
rewrite sold vouchers, allocations, or paid units.

## Acceptance coverage

- A `VoucherStockAdded` event allocates the oldest waiting units in a bounded
  chunk and publishes only with that allocation transaction.
- Partial restock allocates only the oldest paid units and leaves the remainder
  waiting.
- The recovery sweep allocates waiting work even without a stock event.
- Concurrent event and recovery workers preserve one-to-one ownership and
  deterministic per-product FIFO ordering.
- A crash before event completion rolls back all allocations; stale event
  leases recover safely; invalid events need attention without payload logging.
- Load certification exercises 50,000 waiting units plus 50,000 restocked
  vouchers with bounded memory and configured chunks.
