-- Harden voucher allocation event snapshots and typed outbox claims without
-- exposing Orders or Catalog tables to the Fulfilment allocation writer.

BEGIN;

ALTER TABLE "FulfilmentUnit"
  ADD COLUMN "orderPublicReference" UUID,
  ADD COLUMN "productPublicId" UUID;

UPDATE "FulfilmentUnit" AS fulfilment_unit
SET
  "orderPublicReference" = customer_order."publicReference",
  "productPublicId" = product."publicId"
FROM "OrderItem" AS order_item
JOIN "Order" AS customer_order ON customer_order.id = order_item."orderId"
JOIN "Product" AS product ON product.id = order_item."productId"
WHERE order_item.id = fulfilment_unit."orderItemId";

ALTER TABLE "FulfilmentUnit"
  ALTER COLUMN "orderPublicReference" SET NOT NULL,
  ALTER COLUMN "productPublicId" SET NOT NULL;

CREATE INDEX "FulfilmentUnit_orderPublicReference_id_idx"
  ON "FulfilmentUnit"("orderPublicReference", "id");

CREATE INDEX "OutboxEvent_eventType_claimable_availableAt_id_idx"
  ON "OutboxEvent"("eventType", "availableAt", "id")
  INCLUDE ("lockedAt")
  WHERE "publishedAt" IS NULL AND "needsAttentionAt" IS NULL;

COMMIT;
