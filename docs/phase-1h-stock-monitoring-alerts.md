# Phase 1H: Stock monitoring and alerts implementation impact

## Scope, owner, and invariants

Stock Monitoring owns asynchronous inventory measurement, the operational
`NORMAL`, `LOW`, and `EMPTY` state machine, and immutable alert snapshots. It
does not own vouchers, allocations, fulfilment, or communication delivery. The
unit enforces `INV-STK-001` and `INV-STK-002`; existing Fulfilment behaviour
continues to enforce `INV-STK-003`.

Each bounded worker scan evaluates one product from a durable cursor. Eligible
available stock matches allocation eligibility exactly: an `AVAILABLE` voucher
in an imported, activated batch whose validity has not passed. It also measures
paid waiting quantity, oldest waiting paid time, and vouchers sold in the
current UTC calendar day. No counter is written in the allocation hot path.

`NORMAL -> LOW` emits `StockLow` once, `LOW/NORMAL -> EMPTY` emits
`StockEmpty` once, and recovery above the low threshold emits `StockRecovered`.
A partial restock from EMPTY to LOW remains in the same depletion cycle, so a
later EMPTY result cannot repeat the urgent alert. A healthy restock starts the
next cycle. The initial stored state is `NORMAL`, so the first scan of an
already-low or empty product creates one transition alert rather than silently
baselining a potentially urgent condition.

## Data, transactions, and recovery

Migration `20260821130000_stock_monitoring_alerts` adds:

- `StockMonitoringState`, one row per product, with the current state and
  per-cycle alert guards;
- immutable `StockAlert` metric snapshots, unique by product, cycle, and
  transition state;
- the singleton `StockMonitoringSweepState` cursor; and
- a partial sold-voucher index for the daily metric.

The cursor and product state are locked in a short transaction. A state update,
metric snapshot, and `StockLow`, `StockEmpty`, or `StockRecovered` outbox event
commit together. Unique cycle/state and outbox dedupe keys are the final
duplicate defences. Worker replicas use `FOR UPDATE SKIP LOCKED`; if another
worker owns the cursor, the current cycle exits safely and retries later.

The scan processes at most `STOCK_MONITORING_PRODUCT_BATCH_SIZE` products each
cycle and resumes from the durable cursor after crashes. Each evaluation has
constant query count and bounded memory. Voucher and waiting-unit reads use the
existing allocation indexes; the new partial sold index serves the daily count.

## Operations, privacy, and release

`StockAlert` outbox events are consumed by the worker and written as structured
operational log records containing only product public ID and aggregate stock
metrics. There are no voucher PINs, contacts, provider secrets, or queue
payloads. The events are deliberately separate from recipient delivery:
the approved specifications do not define which admin roles, email addresses,
or paging channel should receive a stock notification. That policy and the
admin alert inbox/delivery contract must be decided in the Admin Operations
unit; this implementation does not silently choose recipients.

Monitor low/empty/recovery transition counts, available stock, paid waiting
quantity and age, stock-alert outbox age, needs-attention, poll duration, and
database lock pressure. Deploy the migration before the worker. Rollback after
use is forward-only: stop the stock worker if needed, retain transition and
outbox history, and never mutate voucher ownership to clear an alert.

## Acceptance coverage

- LOW and EMPTY crossings emit a single durable transition per depletion cycle.
- Partial restock does not cause alert spam; healthy restock emits recovery and
  enables a later new LOW/EMPTY cycle.
- Alert snapshots include available stock, paid waiting quantity, sold-today,
  and oldest-waiting metrics without private voucher data, including a paid
  waiting unit when stock reaches zero.
- Bounded cursor scans recover after a worker stop and use row-level locks for
  concurrent workers.
