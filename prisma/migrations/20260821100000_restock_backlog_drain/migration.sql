-- Bounded, restart-safe recovery for paid fulfilment units that are still
-- waiting after stock has been activated. Permanent allocation ownership stays
-- in VoucherAllocation; this state only schedules the next product sweep.

CREATE TABLE "FulfilmentBacklogSweepState" (
  "id" INTEGER NOT NULL,
  "afterProductId" BIGINT,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "FulfilmentBacklogSweepState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FulfilmentBacklogSweepState_singleton" CHECK ("id" = 1)
);

-- Resolves a VoucherStockAdded product reference to its oldest outstanding
-- obligation without scanning paid fulfilment history.
CREATE INDEX "FulfilmentUnit_waiting_productPublicId_fifo_idx"
  ON "FulfilmentUnit"("productPublicId", "paidAt", "id")
  WHERE "allocatedAt" IS NULL;
