CREATE TYPE "StockLevel" AS ENUM ('NORMAL', 'LOW', 'EMPTY');

CREATE TABLE "StockMonitoringState" (
  "productId" BIGINT NOT NULL,
  "state" "StockLevel" NOT NULL DEFAULT 'NORMAL',
  "depletionCycle" INTEGER NOT NULL DEFAULT 0,
  "lowAlertedCycle" INTEGER,
  "emptyAlertedCycle" INTEGER,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "StockMonitoringState_pkey" PRIMARY KEY ("productId"),
  CONSTRAINT "StockMonitoringState_depletionCycle_nonnegative"
    CHECK ("depletionCycle" >= 0),
  CONSTRAINT "StockMonitoringState_lowAlertedCycle_valid"
    CHECK ("lowAlertedCycle" IS NULL OR ("lowAlertedCycle" > 0 AND "lowAlertedCycle" <= "depletionCycle")),
  CONSTRAINT "StockMonitoringState_emptyAlertedCycle_valid"
    CHECK ("emptyAlertedCycle" IS NULL OR ("emptyAlertedCycle" > 0 AND "emptyAlertedCycle" <= "depletionCycle")),
  CONSTRAINT "StockMonitoringState_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "StockAlert" (
  "id" BIGSERIAL NOT NULL,
  "productId" BIGINT NOT NULL,
  "state" "StockLevel" NOT NULL,
  "depletionCycle" INTEGER NOT NULL,
  "availableStock" BIGINT NOT NULL,
  "paidWaitingQuantity" BIGINT NOT NULL,
  "soldToday" BIGINT NOT NULL,
  "oldestWaitingPaidAt" TIMESTAMPTZ(6),
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockAlert_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockAlert_productId_depletionCycle_state_key"
    UNIQUE ("productId", "depletionCycle", "state"),
  CONSTRAINT "StockAlert_depletionCycle_positive" CHECK ("depletionCycle" > 0),
  CONSTRAINT "StockAlert_availableStock_nonnegative" CHECK ("availableStock" >= 0),
  CONSTRAINT "StockAlert_paidWaitingQuantity_nonnegative" CHECK ("paidWaitingQuantity" >= 0),
  CONSTRAINT "StockAlert_soldToday_nonnegative" CHECK ("soldToday" >= 0),
  CONSTRAINT "StockAlert_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "StockAlert_productId_occurredAt_id_idx"
  ON "StockAlert" ("productId", "occurredAt", "id");

CREATE TABLE "StockMonitoringSweepState" (
  "id" INTEGER NOT NULL,
  "afterProductId" BIGINT,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "StockMonitoringSweepState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockMonitoringSweepState_singleton" CHECK ("id" = 1)
);

CREATE INDEX "Voucher_sold_productId_soldAt_idx"
  ON "Voucher" ("productId", "soldAt")
  WHERE "status" = 'SOLD';
