-- Secure voucher allocation foundation.
-- Guarantees one-to-one permanent ownership between a fulfilment unit and a voucher of the same product.

CREATE UNIQUE INDEX IF NOT EXISTS "FulfilmentUnit_id_productId_key"
  ON "FulfilmentUnit"("id", "productId");

CREATE UNIQUE INDEX IF NOT EXISTS "Voucher_id_productId_key"
  ON "Voucher"("id", "productId");

CREATE TABLE IF NOT EXISTS "VoucherAllocation" (
  "id" BIGSERIAL NOT NULL,
  "publicReference" UUID NOT NULL DEFAULT gen_random_uuid(),
  "fulfilmentUnitId" BIGINT NOT NULL,
  "voucherId" BIGINT NOT NULL,
  "productId" BIGINT NOT NULL,
  "allocatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "VoucherAllocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "VoucherAllocation_publicReference_key"
  ON "VoucherAllocation"("publicReference");

CREATE UNIQUE INDEX IF NOT EXISTS "VoucherAllocation_fulfilmentUnitId_key"
  ON "VoucherAllocation"("fulfilmentUnitId");

CREATE UNIQUE INDEX IF NOT EXISTS "VoucherAllocation_voucherId_key"
  ON "VoucherAllocation"("voucherId");

CREATE UNIQUE INDEX IF NOT EXISTS "VoucherAllocation_fulfilmentUnitId_productId_key"
  ON "VoucherAllocation"("fulfilmentUnitId", "productId");

CREATE UNIQUE INDEX IF NOT EXISTS "VoucherAllocation_voucherId_productId_key"
  ON "VoucherAllocation"("voucherId", "productId");

CREATE INDEX IF NOT EXISTS "VoucherAllocation_allocatedAt_id_idx"
  ON "VoucherAllocation"("allocatedAt", "id");

CREATE INDEX IF NOT EXISTS "VoucherAllocation_productId_allocatedAt_id_idx"
  ON "VoucherAllocation"("productId", "allocatedAt", "id");

CREATE INDEX IF NOT EXISTS "Voucher_available_selection_idx"
  ON "Voucher"("productId", "batchId", "id")
  WHERE "status" = 'AVAILABLE';

CREATE INDEX IF NOT EXISTS "FulfilmentUnit_waiting_fifo_idx"
  ON "FulfilmentUnit"("productId", "paidAt", "id")
  WHERE "allocatedAt" IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'VoucherAllocation_fulfilmentUnitId_productId_fkey'
  ) THEN
    ALTER TABLE "VoucherAllocation"
      ADD CONSTRAINT "VoucherAllocation_fulfilmentUnitId_productId_fkey"
      FOREIGN KEY ("fulfilmentUnitId", "productId") REFERENCES "FulfilmentUnit"("id", "productId")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'VoucherAllocation_voucherId_productId_fkey'
  ) THEN
    ALTER TABLE "VoucherAllocation"
      ADD CONSTRAINT "VoucherAllocation_voucherId_productId_fkey"
      FOREIGN KEY ("voucherId", "productId") REFERENCES "Voucher"("id", "productId")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'VoucherAllocation_productId_fkey'
  ) THEN
    ALTER TABLE "VoucherAllocation"
      ADD CONSTRAINT "VoucherAllocation_productId_fkey"
      FOREIGN KEY ("productId") REFERENCES "Product"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
