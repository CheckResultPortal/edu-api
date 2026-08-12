# ADR-017: Catalog hierarchy and money representation

## Status

Accepted.

## Decision

Represent catalogue classifications with a generic self-referencing
`CatalogGroup` hierarchy and attach each sellable `Product` to one group. Store
each product price as an integer number of minor currency units plus an
explicit three-letter ISO currency code.

## Consequences

- Institution, examination, and service categories do not require separate
  schema models or a later migration for each new institution type.
- Product codes and public IDs are stable opaque identifiers for API use;
  database IDs remain internal.
- Avoid floating-point price calculation and make later provider amount/currency
  verification exact.
- A permitted launch-currency policy is still required before admin product
  creation is enabled.
- Deep hierarchy moves must use an application-level ancestor-cycle check; the
  database additionally prevents direct self-parenting.
