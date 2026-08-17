-- Correct the literal plus sign in the Ghana E.164 database check. A character
-- class avoids PostgreSQL string/regular-expression escape ambiguity.

ALTER TABLE "Order"
  DROP CONSTRAINT "Order_phone_ghana_e164";

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_phone_ghana_e164"
  CHECK ("phoneNumber" IS NULL OR "phoneNumber" ~ '^[+]233[0-9]{9}$');
