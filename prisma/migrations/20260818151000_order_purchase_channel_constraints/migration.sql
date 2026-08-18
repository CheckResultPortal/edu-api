-- Record the trusted order source explicitly. All orders created before this
-- migration came from the web API because the USSD adapter does not yet exist.
-- Do not retain a database default: every future writer must state its source.

BEGIN;

CREATE TYPE "PurchaseChannel" AS ENUM ('WEB', 'USSD');

ALTER TABLE "Order"
  ADD COLUMN "purchaseChannel" "PurchaseChannel";

UPDATE "Order"
SET "purchaseChannel" = 'WEB'
WHERE "purchaseChannel" IS NULL;

ALTER TABLE "Order"
  ALTER COLUMN "purchaseChannel" SET NOT NULL;

CREATE INDEX "Order_purchaseChannel_createdAt_id_idx"
  ON "Order"("purchaseChannel", "createdAt", "id");

ALTER TABLE "Order"
  DROP CONSTRAINT IF EXISTS "Order_delivery_contact_consistency";

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_delivery_contact_consistency" CHECK (
    (
      "contactAnonymizedAt" IS NULL
      AND (
        ("deliveryPreference" = 'SMS_ONLY' AND "email" IS NULL)
        OR
        (
          "deliveryPreference" IN ('SMS_AND_EMAIL', 'EMAIL_ONLY')
          AND "email" IS NOT NULL
        )
      )
    )
    OR
    ("contactAnonymizedAt" IS NOT NULL AND "email" IS NULL)
  ),
  ADD CONSTRAINT "Order_web_channel_preference" CHECK (
    "purchaseChannel" != 'WEB' OR "deliveryPreference" = 'SMS_AND_EMAIL'
  ) NOT VALID;

-- The web rule changed after the first pre-release order implementation.
-- NOT VALID preserves historical SMS-only web rows while enforcing the new
-- rule for every insert/update. Validate immediately when no such row exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "Order"
    WHERE "purchaseChannel" = 'WEB'
      AND "deliveryPreference" != 'SMS_AND_EMAIL'
  ) THEN
    ALTER TABLE "Order" VALIDATE CONSTRAINT "Order_web_channel_preference";
  END IF;
END
$$;

COMMIT;
