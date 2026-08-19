# Phase 1E: Secure voucher allocation implementation impact

## Scope, ownership, and authority

Fulfilment owns the permanent allocation between a paid fulfilment unit and an
eligible voucher. Voucher Inventory owns voucher eligibility, batch validity,
and the AVAILABLE to SOLD transition. Payments owns verified payment success
and creates the paid fulfilment units exactly once.

This unit implements INV-VOU-001 through INV-VOU-005 and INV-FUL-001 through
INV-FUL-005. It does not implement the Phase 1F zero-stock backlog drain or the
Phase 1G restock trigger.

The module boundary is intentionally split:

- FulfilmentCoreModule contains only the transactional paid-unit writer needed
  by Payments and Public API.
- VoucherAllocationProcessingModule contains worker-only allocation and outbox
  providers.
- VoucherAllocationInventoryModule exposes only the narrow transactional
  voucher-claiming port. Public API does not load import services or require
  voucher encryption/import settings.

## Authorisation, public contract, and privacy

Allocation is an internal worker process. There is no public endpoint that
selects a voucher or changes allocation ownership.

Each FulfilmentUnit snapshots orderPublicReference and productPublicId when
verified payment creates the obligation. Fulfilment therefore does not read or
mutate Orders or Catalog tables during allocation.

VoucherAllocated is written to the transactional outbox with only:
allocationPublicReference, fulfilmentUnitPublicReference,
orderPublicReference, productPublicId, and allocatedAt.

PIN plaintext, encrypted PIN data, fingerprints, serial numbers, email
addresses, and phone numbers are excluded from outbox events, worker messages,
logs, metrics labels, and traces.

## State and business rules

Voucher lifecycle remains AVAILABLE to SOLD only. An eligible voucher must
satisfy all of the following:

1. Its status is AVAILABLE.
2. Its batch import state is IMPORTED.
3. Its batch has been activated.
4. Its batch validity is open-ended or later than the allocation time.
5. The voucher, batch, and fulfilment unit belong to the same product.

A paid FulfilmentUnit with allocatedAt unset is a durable waiting obligation.
No stock does not reject or cancel the payment. The unit remains waiting and no
voucher state changes are committed.

Waiting units are ordered by paidAt ascending and then internal id ascending.
Eligible vouchers are ordered by batch id ascending and then voucher id
ascending. Both claims use PostgreSQL FOR UPDATE SKIP LOCKED so concurrent
workers do not wait on or claim the same rows.

## Data, constraints, and indexes

VoucherAllocation uses a BIGINT internal key and an opaque UUID public
reference.

Database enforcement includes:

- unique fulfilmentUnitId: one allocation per paid unit;
- unique voucherId: one allocation per voucher;
- composite foreign keys for the fulfilment-unit/product and voucher/product
  pairs, preventing cross-product ownership;
- the existing composite voucher-batch/product foreign key, preventing a
  voucher from referencing another product's batch;
- restricted deletes for permanent ownership facts.

Hot paths use:

- the partial Voucher_available_selection_idx over productId, batchId, and id;
- the partial FulfilmentUnit_waiting_fifo_idx over productId, paidAt, and id;
- OutboxEvent_eventType_claimable_availableAt_id_idx for claimable typed
  PaymentSucceeded events;
- FulfilmentUnit_orderPublicReference_id_idx for the internal event snapshot
  lookup.

Each indexed claim is O(log N) plus a constant row lock. A payment event is
bounded to the paid quantity of 1 through 20. Each poll claims at most 100
events and processes them sequentially, so memory use remains bounded.

## Transactions, idempotency, and concurrency

The worker first claims one PaymentSucceeded outbox event in a short
transaction, recording the worker, lease time, and attempt number.

Processing then uses one PostgreSQL transaction for the entire event:

1. Re-lock and verify the claimed outbox row and worker ownership.
2. Validate the exact version-1 PaymentSucceeded payload.
3. Resolve the product only from FulfilmentUnit snapshots.
4. Repeatedly claim the oldest unlocked waiting unit, bounded by paid quantity.
5. Claim one eligible unlocked voucher through the Voucher Inventory port.
6. Change the voucher from AVAILABLE to SOLD.
7. Insert the permanent allocation and set the unit's allocatedAt value.
8. Insert the private VoucherAllocated outbox event.
9. Mark PaymentSucceeded published.
10. Commit all effects together.

This transaction boundary closes the crash gap: a failure after allocation but
before PaymentSucceeded completion rolls back the sold voucher, allocation,
unit update, VoucherAllocated event, and event completion together. A retry
therefore cannot allocate extra vouchers.

Unique constraints remain the final duplicate defense. Concurrent workers use
the same waiting-unit and voucher lock order. The transaction is bounded to a
maximum of 20 allocations and contains no network calls.

## Failure handling, recovery, and operations

- A crash before commit leaves no partial allocation state.
- A crash after commit leaves allocation and both outbox facts durable.
- Stale claims become eligible after the configured lease.
- Transient failures use bounded exponential retry with jitter.
- Invalid payloads and exhausted attempts move to needs-attention.
- Retry configuration rejects a maximum delay below its base delay.
- A zero-stock event is completed without allocation; its paid unit remains
  waiting for the separately specified backlog/restock phases.
- The worker logs processed event counts and cycle failures without voucher
  secrets or customer contact data.

Worker settings are VOUCHER_ALLOCATION_OUTBOX_BATCH_SIZE,
VOUCHER_ALLOCATION_POLL_INTERVAL_MS, VOUCHER_ALLOCATION_LEASE_MS,
VOUCHER_ALLOCATION_MAX_ATTEMPTS,
VOUCHER_ALLOCATION_RETRY_BASE_DELAY_MS, and
VOUCHER_ALLOCATION_RETRY_MAX_DELAY_MS.

Operational dashboards and alerts for waiting age, allocation duration, outbox
age, needs-attention growth, lock pressure, and throughput remain part of the
later reliability/operations certification. The durable database facts needed
for those measurements are present.

## Migration and deployment notes

Migration 20260819090000_voucher_allocation creates VoucherAllocation, permanent
ownership constraints, and the partial waiting/voucher selection indexes.

Migration 20260819093000_voucher_allocation_hardening:

1. Adds nullable order and product public-reference snapshots.
2. Backfills them from existing relationally constrained rows.
3. Makes both snapshots required.
4. Adds the snapshot lookup and typed outbox claim indexes.

Migration 20260819094500_voucher_allocation_schema_alignment removes the older
redundant full waiting-unit index in favor of the smaller partial FIFO index and
aligns VoucherAllocation UUID generation with the Prisma schema.

Deploy migrations before starting workers that write the new fields. For a
production database containing paid units or allocations, do not roll back by
dropping ownership data. Stop allocation workers and use a reviewed forward
repair migration. A rollback before live use may drop only the added indexes,
snapshot columns, allocation foreign keys/indexes, and allocation table in
reverse dependency order.

## Acceptance and verification

Automated coverage includes:

1. Atomic AVAILABLE-to-SOLD allocation and private VoucherAllocated payload.
2. FIFO selection with partial stock.
3. Zero-stock preservation without order or payment cancellation.
4. Expired and unactivated batch exclusion.
5. Database rejection of cross-product allocation.
6. One winner under 100 concurrent workers competing for one voucher.
7. Exact version-1 PaymentSucceeded payload validation.
8. Duplicate consumption protection and event publication.
9. Simulated crash after allocation but before event completion, proving full
   rollback and exactly one allocation on recovery.
10. Exponential retry, stale-lock recovery semantics, and terminal
    needs-attention behavior.
11. Load certification of 10,000 vouchers with 20 concurrent bounded workers.
12. Payments regression tests and Public API end-to-end startup without
    worker-only voucher or allocation configuration.

The next approved delivery unit is Phase 1F: zero-stock paid backlog behavior,
followed by Phase 1G restock drain. Those phases must reuse this allocator and
must not introduce a second allocation writer.
