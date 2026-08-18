-- Capture the approved Phase 1 customer name and delivery preference without
-- changing previously committed order migrations.

CREATE TYPE "OrderDeliveryPreference" AS ENUM ('SMS_ONLY', 'SMS_AND_EMAIL');

ALTER TABLE "Order"
  ADD COLUMN "firstName" TEXT,
  ADD COLUMN "deliveryPreference" "OrderDeliveryPreference";

-- Preserve any pre-release development orders without inventing a customer
-- name. Their preference can be inferred safely from the existing contact.
UPDATE "Order"
SET "deliveryPreference" = CASE
  WHEN "email" IS NULL THEN 'SMS_ONLY'::"OrderDeliveryPreference"
  ELSE 'SMS_AND_EMAIL'::"OrderDeliveryPreference"
END;

ALTER TABLE "Order"
  ALTER COLUMN "deliveryPreference" SET NOT NULL;

ALTER TABLE "Order"
  DROP CONSTRAINT "Order_contact_anonymization";

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_firstName_normalized" CHECK (
    "firstName" IS NULL OR (
      char_length("firstName") BETWEEN 1 AND 100
      AND "firstName" = btrim("firstName")
    )
  ),
  ADD CONSTRAINT "Order_delivery_contact_consistency" CHECK (
    (
      "contactAnonymizedAt" IS NULL
      AND (
        ("deliveryPreference" = 'SMS_ONLY' AND "email" IS NULL)
        OR
        ("deliveryPreference" = 'SMS_AND_EMAIL' AND "email" IS NOT NULL)
      )
    )
    OR
    ("contactAnonymizedAt" IS NOT NULL AND "email" IS NULL)
  ),
  ADD CONSTRAINT "Order_contact_anonymization" CHECK (
    (
      "contactAnonymizedAt" IS NULL
      AND "firstName" IS NOT NULL
      AND "phoneNumber" IS NOT NULL
    )
    OR
    (
      "contactAnonymizedAt" IS NOT NULL
      AND "firstName" IS NULL
      AND "phoneNumber" IS NULL
      AND "email" IS NULL
    )
  ) NOT VALID;

-- The NOT VALID contact constraint is enforced for every new or updated row.
-- It can be validated after any pre-release legacy rows without a first name
-- have either been backfilled from an approved source or anonymized.
