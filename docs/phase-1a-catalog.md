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

Public reads have no transaction or idempotency requirement. Future catalog
writes will use short PostgreSQL transactions and write safe-reference outbox
events (`CatalogProductCreated`, `CatalogProductPriceChanged`, or
`CatalogProductActivationChanged`) with the state change. Audit logging and
admin authorisation are mandatory for those writes.

Record public product-query count, duration, result count, and rejected query
validation without sensitive data. There is no failure recovery workflow for a
read; database unavailability follows the existing safe API failure contract.

## Authorisation and open decisions

Public product reads are guest-accessible. Product/group creation, price
changes, activation, and hierarchy changes are high-risk admin operations and
must not be exposed until the project selects the admin identity/session model,
RBAC policy, MFA/step-up rules, and audit-event storage policy. No unprotected
admin route is added as a placeholder.

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
