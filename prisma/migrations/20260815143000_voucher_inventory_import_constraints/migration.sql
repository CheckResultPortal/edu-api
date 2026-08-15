-- Defense-in-depth constraints for the voucher import command. This is a
-- separate migration because the foundation migration may already be applied.

ALTER TABLE "VoucherBatch"
  ADD CONSTRAINT "VoucherBatch_reference_not_blank_or_oversized"
  CHECK (char_length(btrim("reference")) BETWEEN 1 AND 256),
  ADD CONSTRAINT "VoucherBatch_completed_import_has_vouchers"
  CHECK (
    "importState" <> 'IMPORTED'
    OR "totalQuantity" > 0
  );

ALTER TABLE "VoucherBatch"
  DROP CONSTRAINT "VoucherBatch_activation_after_completed_import",
  ADD CONSTRAINT "VoucherBatch_activation_after_completed_import"
  CHECK (
    "activatedAt" IS NULL
    OR (
      "importState" = 'IMPORTED'
      AND "totalQuantity" > 0
    )
  );

ALTER TABLE "Voucher"
  ADD CONSTRAINT "Voucher_serialNumber_not_blank_or_oversized"
  CHECK (char_length(btrim("serialNumber")) BETWEEN 1 AND 256),
  ADD CONSTRAINT "Voucher_pinFingerprint_format"
  CHECK ("pinFingerprint" ~ '^[A-Za-z0-9_-]{43}$');
