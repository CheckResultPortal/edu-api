# Event-triggered worker processing

Owner: database infrastructure supplies wakeups; Payments, Fulfilment and
Communication retain all business processing and existing durable claims.
PostgreSQL outbox/delivery records remain authoritative. Notifications contain
only fixed topic names, never references, contacts, credentials or provider data.
PostgreSQL delivers notifications after commit; rolled-back work cannot trigger
business effects. All workers still claim through existing locks and constraints.

Use one dedicated LISTEN connection per worker process, opened lazily by worker
subscriptions. APIs do not subscribe. Reconnect and startup drain durable work.
Notifications during a running batch coalesce into another pass. Full batches
continue immediately, yielding between batches. No overlapping local cycles;
cross-process duplicate signals are safe through existing claims/idempotency.
Retries retain nextAttemptAt/availableAt and leases; signals never bypass them.
A shared five-second recovery sweep catches missed signals and due retries.
Imports already stream immediately; stale-import recovery timing stays.
Payment provider verification/recovery, timeouts, retry backoff, stock monitoring,
reconciliation and maintenance timing remain. No payment policy changes.

Migration adds notification triggers only, no data rewrite or new indexes.
Existing bounded indexed queries and batch sizes remain. Extra DB connection per
worker; monitor connection/pool pressure, notification queue usage, outbox age,
backlog age, provider failure rates and worker processing throughput. LISTEN uses
a direct or session-pooled connection; transaction-pooling is unsupported.
Listener errors log only a fixed safe message; recovery continues during outage.

Deploy migration before new worker code. Remove old normal polling settings:
USSD_PAYMENT_PROMPT_POLL_INTERVAL_MS, VOUCHER_ALLOCATION_POLL_INTERVAL_MS,
RESTOCK_DRAIN_POLL_INTERVAL_MS, VOUCHER_DELIVERY_POLL_INTERVAL_MS,
VOUCHER_RETRIEVAL_EMAIL_POLL_INTERVAL_MS. Old values are ignored.
WORKER_RECOVERY_INTERVAL_MS is optional (5000 default), exclusively a recovery
sweep, not the normal dispatch path. No changes to real local env files.
Rollback worker first to polling version, then drop the three triggers and two
functions in the migration if desired. Never remove outbox/delivery records.

Validation: scheduler burst/non-overlap/draining/failure/shutdown tests, listener
reconnection and commit/rollback integration tests, config tests, affected builds
and lint. Provider/network duration is not an instant-delivery guarantee.

References: https://www.postgresql.org/docs/current/sql-notify.html and
https://node-postgres.com/apis/client .

Local validation: worker Nx build (including 16 dependencies), worker/public/admin
TypeScript builds, ESLint and 110 unit tests passed. PostgreSQL integration suites
were skipped (27 tests, including two notification migration tests): Docker was
not running and no disposable TEST_WORKER_DATABASE_URL was available. Run these
before production rollout; no live database or provider requests were made.
