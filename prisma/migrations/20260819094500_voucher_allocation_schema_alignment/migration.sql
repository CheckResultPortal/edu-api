-- Remove redundant schema objects left by the pre-allocation fulfilment model.

BEGIN;

DROP INDEX IF EXISTS "FulfilmentUnit_productId_allocatedAt_paidAt_id_idx";

ALTER TABLE "VoucherAllocation"
  ALTER COLUMN "publicReference" DROP DEFAULT;

COMMIT;
