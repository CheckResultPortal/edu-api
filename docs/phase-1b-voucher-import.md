# Phase 1B: Voucher batch import and activation

## Scope and ownership

Voucher Inventory owns voucher batches, encrypted voucher credentials, and
availability. Catalog remains the only owner of the product, its authoritative
price, currency, activation, result-checker URL, and low-stock threshold.

Customer delivery files are deliberately outside this import unit. After the
later verified-payment, fulfilment, allocation, and communication units, each
customer must receive their allocated serial/PIN in both a PDF and a CSV
delivery artifact. Those artifacts will be rendered only from an existing
allocation at send time, kept out of queues/logs/audits/permanent attachment
storage, and sent by the communication workflow; a PDF is never an inventory
source format.

An administrator selects an existing Catalog product when importing a batch.
The CSV contains exactly the credential columns below; it must never carry a
price, currency, or result-checker URL.

```csv
serialNumber,pin
WAEC-SERIAL-001,123456789012
```

`serialNumber` is trimmed before storage. `pin` is preserved exactly (including
quoted CSV content) because it is a secret. A batch also records an operator
reference and an optional RFC 3339 `validUntil` instant. Batch validity is an
allocation-eligibility input for the later allocation unit; it is not a voucher
status.

## State and invariants

Voucher lifecycle remains only `AVAILABLE -> SOLD`. No import or operational
state is stored on the voucher itself. A `VoucherBatch` has a separate progress
state:

- `IMPORTING`: encrypted chunks may be written, but the batch is ineligible.
- `IMPORTED`: all rows were validated and persisted, but the batch is still
  ineligible until an explicit activation.
- `FAILED`: an invalid, interrupted, or stale import; it cannot be activated.
- `DISCARDED`: the inactive batch's encrypted voucher rows have been erased.

Only an `IMPORTED` batch can be activated. Activation writes exactly one
`VoucherStockAdded` transactional-outbox event; repeat activation returns the
same batch with `changed: false` and creates no second event. Communication
workers are not involved in importing or inventory allocation.

## Authorisation and privacy

All routes are Admin API routes protected by the session/TOTP guard. Both
`SUPER_ADMIN` and `OPERATIONS_ADMIN` may import, activate, and discard batches;
each operation is recorded in `AdminSecurityEvent` with only public references,
counts, and safe failure categories.

PINs are AES-256-GCM encrypted before persistence using
`VOUCHER_SECRET_ENCRYPTION_KEY_ID` and `VOUCHER_SECRET_ENCRYPTION_KEY`.
`VOUCHER_PIN_FINGERPRINT_KEY` is a distinct HMAC key used solely for duplicate
detection. PINs never enter the database as plaintext, logs, audits, errors,
outbox payloads, or queue payloads. CSV validation errors identify only a row
number and category.

Generate the three 32-byte base64url values with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Use a separate generated value for each encryption/fingerprint purpose. Set
them through local/deployment secret injection, never a committed env file.

## API contract

- `POST /v1/admin/voucher-batches/import?productPublicId=<uuid>&reference=<text>&validUntil=<RFC3339>`
  accepts `Content-Type: text/csv` and returns an `IMPORTED` batch. It streams
  and validates the body, and does not activate the stock.
- `GET /v1/admin/voucher-batches/:publicId` returns the batch's safe
  operational metadata and state, never credentials.
- `POST /v1/admin/voucher-batches/:publicId/activate` makes the completed batch
  allocation-eligible and writes the durable stock event.
- `POST /v1/admin/voucher-batches/:publicId/discard` permanently erases the
  encrypted voucher rows of an inactive batch in bounded chunks. Activated
  batches cannot be discarded.

The import maximum defaults to 64 MiB and `VOUCHER_IMPORT_CHUNK_SIZE` defaults
to 1,000 rows. The parser uses O(chunk-size) row memory; it rejects malformed
CSV, extra/missing columns, invalid/empty credentials, fields above bounded
size, control characters, and files without the exact header. A caller should treat an import
request as non-replayable administrative work: a retry after an unknown
connection outcome must first inspect the recorded batch/audit state rather
than blindly upload the same credentials again.

## Database, transactions, and recovery

`Voucher` has product-scoped unique constraints on `(productId, serialNumber)`
and `(productId, pinFingerprint)`, plus a batch/product composite foreign key.
Database checks reject blank/oversized references and serials, malformed HMAC
fingerprints, completed empty batches, and activation without completed stock.
Those constraints handle concurrent import races; application checks provide a
clear safe error before the database conflict where possible. The available
voucher index is partial and supports the later allocator without an inventory
scan.

Each import chunk runs in a short serializable transaction: verify the batch is
still `IMPORTING`, check the bounded product-scoped candidate set, bulk insert
the encrypted rows, and increment the batch count. There is no one-row Prisma
create loop and no external network call inside a transaction. Failed requests
mark their batch `FAILED`; a worker also marks stale `IMPORTING` batches failed
after `VOUCHER_IMPORT_STALE_AFTER_MS`, polling at
`VOUCHER_IMPORT_RECOVERY_POLL_INTERVAL_MS`. Administrators can resume recovery
by discarding the failed batch, which deletes at most one configured chunk per
transaction and is safe to repeat after a crash.

The forward migration is additive. For a production rollback, first disable
the import/activation routes and retain the encrypted rows and outbox history;
do not drop voucher tables or enum types from a live database. A later forward
migration can remove unused tables only after an approved retention decision.

## Observability and acceptance checks

Operators should monitor imported/failed/discarded batch counts, available
stock by product, stale-import recovery count, import duration, row throughput,
duplicate conflicts, activation/outbox age, and database transaction/lock
pressure. Alert on stale/failed import growth, low or empty stock transitions
(implemented by the later stock-monitoring unit), outbox backlog, and
reconciliation mismatches.

The implemented checks cover streaming CSV boundaries and quote handling,
secret-safe parser errors, a 100,000-row streaming run that consumes only
configured-size parsed chunks, PostgreSQL encryption at rest, within-file
duplicate rejection, product-scoped constraints, the `AVAILABLE` initial state,
and a single durable event across repeated activation. Admin API end-to-end
checks cover the public OpenAPI contract and rejection of an unauthenticated
CSV upload before credential handling.
