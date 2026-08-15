-- Voucher inventory import foundation. Voucher lifecycle is deliberately
-- restricted to AVAILABLE -> SOLD; import progress belongs to the batch.

CREATE TYPE "VoucherStatus" AS ENUM ('AVAILABLE', 'SOLD');
CREATE TYPE "VoucherBatchImportState" AS ENUM (
  'IMPORTING', 'IMPORTED', 'FAILED', 'DISCARDED'
);

CREATE TABLE "VoucherBatch" (
  "id" BIGSERIAL NOT NULL,
  "publicId" UUID NOT NULL,
  "productId" BIGINT NOT NULL,
  "reference" TEXT NOT NULL,
  "validUntil" TIMESTAMPTZ(6),
  "importState" "VoucherBatchImportState" NOT NULL DEFAULT 'IMPORTING',
  "totalQuantity" INTEGER NOT NULL DEFAULT 0,
  "activatedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "VoucherBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VoucherBatch_totalQuantity_nonnegative"
    CHECK ("totalQuantity" >= 0),
  CONSTRAINT "VoucherBatch_activation_after_completed_import"
    CHECK (
      "activatedAt" IS NULL
      OR "importState" = 'IMPORTED'
    )
);

CREATE UNIQUE INDEX "VoucherBatch_publicId_key" ON "VoucherBatch"("publicId");
CREATE UNIQUE INDEX "VoucherBatch_id_productId_key" ON "VoucherBatch"("id", "productId");
CREATE INDEX "VoucherBatch_productId_activatedAt_id_idx"
  ON "VoucherBatch"("productId", "activatedAt", "id");
CREATE INDEX "VoucherBatch_importState_updatedAt_id_idx"
  ON "VoucherBatch"("importState", "updatedAt", "id");

ALTER TABLE "VoucherBatch"
  ADD CONSTRAINT "VoucherBatch_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Voucher" (
  "id" BIGSERIAL NOT NULL,
  "publicId" UUID NOT NULL,
  "productId" BIGINT NOT NULL,
  "batchId" BIGINT NOT NULL,
  "serialNumber" TEXT NOT NULL,
  "encryptedPin" JSONB NOT NULL,
  "pinFingerprint" TEXT NOT NULL,
  "status" "VoucherStatus" NOT NULL DEFAULT 'AVAILABLE',
  "soldAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Voucher_soldAt_matches_status"
    CHECK (
      ("status" = 'AVAILABLE' AND "soldAt" IS NULL)
      OR ("status" = 'SOLD' AND "soldAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "Voucher_publicId_key" ON "Voucher"("publicId");
CREATE UNIQUE INDEX "Voucher_productId_serialNumber_key"
  ON "Voucher"("productId", "serialNumber");
CREATE UNIQUE INDEX "Voucher_productId_pinFingerprint_key"
  ON "Voucher"("productId", "pinFingerprint");
CREATE INDEX "Voucher_batchId_id_idx" ON "Voucher"("batchId", "id");
CREATE INDEX "Voucher_available_productId_id_idx"
  ON "Voucher"("productId", "id") WHERE "status" = 'AVAILABLE';

ALTER TABLE "Voucher"
  ADD CONSTRAINT "Voucher_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Voucher"
  ADD CONSTRAINT "Voucher_batch_product_match_fkey"
  FOREIGN KEY ("batchId", "productId")
  REFERENCES "VoucherBatch"("id", "productId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
