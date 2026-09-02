CREATE TABLE "VoucherRetrievalEmailDelivery" (
  "id" BIGSERIAL NOT NULL,
  "publicId" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" BIGINT NOT NULL,
  "destinationEmail" TEXT NOT NULL,
  "state" "CommunicationDeliveryState" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processingLeaseUntil" TIMESTAMPTZ(6),
  "sentAt" TIMESTAMPTZ(6),
  "providerMessageId" TEXT,
  "lastFailureCategory" TEXT,
  "needsAttentionAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "VoucherRetrievalEmailDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VoucherRetrievalEmailDelivery_publicId_key" UNIQUE ("publicId"),
  CONSTRAINT "VoucherRetrievalEmailDelivery_attempt_count" CHECK ("attemptCount" >= 0),
  CONSTRAINT "VoucherRetrievalEmailDelivery_state_consistency" CHECK (
    ("state" = 'PROCESSING') = ("processingLeaseUntil" IS NOT NULL)
    AND ("state" = 'SENT') = ("sentAt" IS NOT NULL)
    AND ("state" IN ('UNKNOWN', 'NEEDS_ATTENTION')) = ("needsAttentionAt" IS NOT NULL)
  ),
  CONSTRAINT "VoucherRetrievalEmailDelivery_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "VoucherRetrievalEmailDelivery_state_nextAttemptAt_id_idx"
  ON "VoucherRetrievalEmailDelivery" ("state", "nextAttemptAt", "id");
CREATE INDEX "VoucherRetrievalEmailDelivery_orderId_createdAt_id_idx"
  ON "VoucherRetrievalEmailDelivery" ("orderId", "createdAt", "id");
CREATE INDEX "VoucherRetrievalEmailDelivery_processingLeaseUntil_id_idx"
  ON "VoucherRetrievalEmailDelivery" ("processingLeaseUntil", "id")
  WHERE "state" = 'PROCESSING';

CREATE TABLE "VoucherRetrievalEmailAttempt" (
  "id" BIGSERIAL NOT NULL,
  "deliveryId" BIGINT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "outcome" "CommunicationAttemptOutcome" NOT NULL DEFAULT 'PROCESSING',
  "providerMessageId" TEXT,
  "providerCode" TEXT,
  "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(6),
  CONSTRAINT "VoucherRetrievalEmailAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VoucherRetrievalEmailAttempt_deliveryId_attemptNumber_key" UNIQUE ("deliveryId", "attemptNumber"),
  CONSTRAINT "VoucherRetrievalEmailAttempt_attempt_number" CHECK ("attemptNumber" > 0),
  CONSTRAINT "VoucherRetrievalEmailAttempt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "VoucherRetrievalEmailDelivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "VoucherRetrievalEmailAttempt_deliveryId_startedAt_idx"
  ON "VoucherRetrievalEmailAttempt" ("deliveryId", "startedAt");
