# Phase 1A: Catalog

## Scope, owner, and authority

The Catalog module owns the reusable catalogue hierarchy, sellable products,
authoritative prices, product activation, and low-stock threshold settings. It
implements the approved Product Catalog specification and prepares the product
side of the later order price-snapshot contract. It does not create voucher
inventory, orders, payments, allocations, communication records, or stock
alerts.

The catalogue is an adjacency-list hierarchy: a broad area can contain an
institution or authority, which can contain an examination or service group.
For example, `EDUCATION -> WAEC -> WASSCE` can contain a sellable result-checker
product. The same model supports universities, technical universities,
colleges, nursing/health, government, and future categories without adding
columns or separate tables per institution type.

## Rules and boundaries

- Catalog owns backend-authoritative product price, `isActive`, and
  `lowStockThreshold`.
- A product belongs to one existing catalogue group. Product codes and public
  IDs are unique.
- Public reads return active products only and expose opaque public IDs, never
  internal database IDs.
- Prices are positive integer minor units with an explicit three-letter ISO
  currency code. The permitted launch currency/currencies remain a product
  policy decision; the schema does not silently assume one.
- A product may publish one official HTTPS result-checker URL. It is customer
  guidance only: voucher delivery must never depend on visiting that site, and
  the product administrator is responsible for keeping the official link
  current.
- An inactive product will be rejected by the later order command. Existing
  order-item price snapshots are owned and preserved by the Orders module.
- Catalogue group hierarchy cannot self-reference. The admin group-move command
  must also reject ancestor cycles before it is introduced.
- No external provider call, queue action, or inventory mutation occurs in this
  unit.

## Data, indexing, and complexity

`CatalogGroup` uses a self-referencing `parentId` adjacency list with a
parent/sort index. `Product` has unique code/public-ID constraints, a database
foreign key to its group, non-negative threshold and positive-price checks, and
a partial active-product keyset index.

Public product lists use cursor/keyset pagination by opaque product public ID
and a bounded limit of at most 100. The database work is indexed and O(page
size); application memory is O(page size). It never loads the whole catalogue.

## Transactions, recovery, and observability

Public reads have no transaction or idempotency requirement. Catalog writes use
short serializable PostgreSQL transactions. The Administration module composes
the Catalog command and the `AdminSecurityEvent` audit write in that same
transaction; Catalog remains the owner of product/group state and outbox rows.

Product creation, price changes, and activation changes write one safe-reference
outbox event (`CatalogProductCreated`, `CatalogProductPriceChanged`, or
`CatalogProductActivationChanged`) in the same transaction as the state
transition. Event payloads contain public product/group references, currency,
price minor units, activation state, and event version only. They never contain
voucher material, credentials, or browser/provider secrets.

Catalog group moves run an ancestor-cycle query inside that serializable
transaction. A uniqueness violation or serialization conflict is returned as a
safe conflict response; no external request is made inside the transaction, so
the caller may retry. Repeating an activation/deactivation or price command
with the already-current state is a state no-op and creates no duplicate outbox
event, although the privileged action is still audited. Catalog creation and
metadata-update routes do not yet provide response-replay idempotency keys:
their database uniqueness constraints remain the duplicate-write protection.

The HTTP foundation records structured request route, status, duration, and
correlation ID. Operational monitoring should alert on elevated admin 4xx/5xx
responses, serialization conflicts, and unpublished catalog-outbox age once
the platform metrics exporter is introduced; that exporter is outside this
Catalog unit.

Record public product-query count, duration, result count, and rejected query
validation without sensitive data. There is no failure recovery workflow for a
read; database unavailability follows the existing safe API failure contract.

## Authorisation and open decisions

Public product reads are guest-accessible. Product/group creation, updates,
price changes, activation, and hierarchy changes are protected Admin API
operations. They require the authenticated, TOTP-protected admin session and
either approved role: `SUPER_ADMIN` or `OPERATIONS_ADMIN`. Every successful or
state-no-op privileged command records actor, correlation ID, action, and a
safe public resource reference in `AdminSecurityEvent`.

The Admin API exposes the following JSON:API routes:

- `POST /v1/admin/catalog-groups` and `PATCH /v1/admin/catalog-groups/:publicId`
- `POST /v1/admin/products` and `PATCH /v1/admin/products/:publicId`
- `PUT /v1/admin/products/:publicId/price`
- `POST /v1/admin/products/:publicId/activate`
- `POST /v1/admin/products/:publicId/deactivate`

Request schemas reject unknown properties, bound description and URL size, and
validate all identifiers and numeric values before the database transaction.
The active session’s mandatory TOTP verification is the current MFA control;
there is no separate fresh-authentication policy yet for catalog price changes.

The launch-currency allow-list remains an explicit unresolved product decision.
This implementation deliberately retains the accepted generic ISO-4217 shape
and does not silently restrict catalog creation to GHS. Add an approved policy
and validation change before enabling a currency-specific launch restriction.

## Implementation impact and verification

- **Owner and boundaries:** Catalog owns hierarchy/product validation, state,
  and durable events. Administration owns RBAC and audit records and calls the
  exported Catalog command contract rather than mutating catalog tables.
- **Data and scale:** Existing `CatalogGroup`, `Product`, `OutboxEvent`, and
  `AdminSecurityEvent` constraints and indexes fully support this unit; no new
  migration is required. Product writes are indexed O(1) point work. A group
  move is O(tree depth) in PostgreSQL and uses constant application memory.
- **Failure/recovery:** PostgreSQL rolls back state, audit, and outbox together.
  A later outbox publisher can safely recover an unpublished committed event;
  no network side effect occurs during a catalog transaction.
- **Tests:** unit validation covers patch/price validation. PostgreSQL
  integration coverage verifies product state + audit + outbox atomicity,
  no-op activation behavior, rejected-group rollback, and ancestor-cycle
  prevention, including opposing concurrent group-move attempts. The generated
  Admin OpenAPI document declares every protected command.

## Acceptance checks

- Product code/public-ID uniqueness, group foreign key, positive price, valid
  currency shape, non-negative threshold, and self-parent prevention are
  database enforced.
- Domain validation rejects invalid product/group input before persistence.
- Public queries are bounded, return only active products, and use opaque
  identifiers.
- The generated OpenAPI contract describes the public list/get operations.
- Unit tests, schema validation, lint, build, formatting, and a PostgreSQL
  migration review pass. Real-PostgreSQL integration tests are run when the
  local Compose services are available.
- Protected operations are rejected without a valid TOTP-authenticated session;
  both approved roles can manage the catalogue, while administration identity
  management remains Super-Admin-only.
