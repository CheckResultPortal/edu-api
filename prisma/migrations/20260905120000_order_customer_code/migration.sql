ALTER TABLE "Order" ADD COLUMN "customerCode" VARCHAR(6);
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerCode_format"
  CHECK ("customerCode" IS NULL OR "customerCode" ~ '^[1-9][0-9]{5}$');
CREATE UNIQUE INDEX "Order_customerCode_key" ON "Order"("customerCode");
