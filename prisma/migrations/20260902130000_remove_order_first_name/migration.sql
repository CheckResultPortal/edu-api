-- There are no production orders yet, so customer names can be removed
-- without a data-retention backfill. Keep the contact-anonymisation rule,
-- but base it only on the delivery contacts that are still collected.

ALTER TABLE "Order"
  DROP CONSTRAINT IF EXISTS "Order_firstName_normalized",
  DROP CONSTRAINT IF EXISTS "Order_contact_anonymization";

ALTER TABLE "Order"
  DROP COLUMN "firstName";

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_contact_anonymization" CHECK (
    (
      "contactAnonymizedAt" IS NULL
      AND "phoneNumber" IS NOT NULL
    )
    OR
    (
      "contactAnonymizedAt" IS NOT NULL
      AND "phoneNumber" IS NULL
      AND "email" IS NULL
    )
  ) NOT VALID;
