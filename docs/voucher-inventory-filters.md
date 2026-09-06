# Voucher inventory filters

Administration owns read-only category/product/status filters. Filters compose
server-side before cursor pagination; no PIN fields are selected. Category uses
existing product.catalogGroup relation; public UUID input is validated. Combining
a product from a different category returns no rows. Existing Product category
and Voucher product/status indexes support selection; no schema migration.
Dropdowns load bounded pages with explicit load-more controls. New filter values
reset voucher pagination; stale requests must not replace newer results. Product
options narrow to the selected category; category change clears product selection.
Existing imports and allocations remain unchanged. Tests assert composed queries,
UUID validation, bounded reads and cursor handling. Category selection matches the
product's assigned category, not an inferred descendant tree.
