CREATE TYPE "ReconciliationFindingStatus" AS ENUM ('OPEN', 'RESOLVED');

CREATE TABLE "ReconciliationFinding" (
    "id" BIGSERIAL NOT NULL,
    "publicId" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" "ReconciliationFindingStatus" NOT NULL DEFAULT 'OPEN',
    "summary" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "firstDetectedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(6),
    CONSTRAINT "ReconciliationFinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReconciliationFinding_publicId_key"
ON "ReconciliationFinding"("publicId");
CREATE UNIQUE INDEX "ReconciliationFinding_fingerprint_key"
ON "ReconciliationFinding"("fingerprint");
CREATE INDEX "ReconciliationFinding_status_lastDetectedAt_id_idx"
ON "ReconciliationFinding"("status", "lastDetectedAt", "id");
CREATE INDEX "ReconciliationFinding_type_status_lastDetectedAt_id_idx"
ON "ReconciliationFinding"("type", "status", "lastDetectedAt", "id");

CREATE INDEX "Order_phoneNumber_createdAt_id_idx"
ON "Order"("phoneNumber", "createdAt", "id");
CREATE INDEX "Order_email_createdAt_id_idx"
ON "Order"("email", "createdAt", "id");
CREATE INDEX "PaymentAttempt_providerReference_id_idx"
ON "PaymentAttempt"("providerReference", "id");
CREATE INDEX "Voucher_serialNumber_id_idx"
ON "Voucher"("serialNumber", "id");

ALTER TABLE "ReconciliationFinding"
ADD CONSTRAINT "ReconciliationFinding_occurrenceCount_check"
CHECK ("occurrenceCount" > 0);

ALTER TABLE "ReconciliationFinding"
ADD CONSTRAINT "ReconciliationFinding_resolution_check"
CHECK (
  ("status" = 'OPEN' AND "resolvedAt" IS NULL)
  OR ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL)
);
