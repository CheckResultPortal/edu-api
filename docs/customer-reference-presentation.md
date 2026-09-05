# Customer reference presentation

Orders owns the stored six-digit customerCode. Display EDUPAY- plus that code
across web, USSD and communications; never substitute payment-attempt references.
Legacy orders without codes retain their UUID. Accept the prefix at lookup and
strip it before existing phone authorization and indexed database lookup.

No schema, allocation, payment, idempotency, events or retry changes. Communication
reads the related order code with its existing bounded claim query. PINs remain
decrypted only for sending. Presentation changes are linear in bounded text size.
Deploy backend before frontend. Rollback changes presentation only. Validate
prefix normalization, legacy compatibility, delivery rendering and app builds.

The current attachment generator produces PDF and CSV, not Word. Word attachment
support and visual redesign are separate remaining work; do not relabel CSV as Word.
