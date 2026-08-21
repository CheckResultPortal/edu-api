CREATE TYPE "CommunicationPurpose" AS ENUM ('VOUCHER_DELIVERY');
CREATE TYPE "CommunicationDeliveryChannel" AS ENUM ('SMS', 'EMAIL');
CREATE TYPE "CommunicationDeliveryState" AS ENUM ('PENDING', 'PROCESSING', 'RETRYING', 'SENT', 'UNKNOWN', 'NEEDS_ATTENTION');
CREATE TYPE "CommunicationAttemptOutcome" AS ENUM ('PROCESSING', 'SENT', 'TEMPORARY', 'PERMANENT', 'RATE_LIMITED', 'AUTHENTICATION', 'INVALID_REQUEST', 'UNKNOWN_OUTCOME');

CREATE TABLE "Communication" (
  "id" BIGSERIAL NOT NULL,
  "publicId" UUID NOT NULL DEFAULT gen_random_uuid(),
  "allocationId" BIGINT NOT NULL,
  "purpose" "CommunicationPurpose" NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Communication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Communication_publicId_key" UNIQUE ("publicId"),
  CONSTRAINT "Communication_allocationId_key" UNIQUE ("allocationId"),
  CONSTRAINT "Communication_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "VoucherAllocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "CommunicationDelivery" (
  "id" BIGSERIAL NOT NULL,
  "publicId" UUID NOT NULL DEFAULT gen_random_uuid(),
  "communicationId" BIGINT NOT NULL,
  "channel" "CommunicationDeliveryChannel" NOT NULL,
  "destination" TEXT NOT NULL,
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
  CONSTRAINT "CommunicationDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommunicationDelivery_publicId_key" UNIQUE ("publicId"),
  CONSTRAINT "CommunicationDelivery_communicationId_channel_key" UNIQUE ("communicationId", "channel"),
  CONSTRAINT "CommunicationDelivery_attempt_count" CHECK ("attemptCount" >= 0),
  CONSTRAINT "CommunicationDelivery_state_consistency" CHECK (
    ("state" = 'PROCESSING') = ("processingLeaseUntil" IS NOT NULL)
    AND ("state" = 'SENT') = ("sentAt" IS NOT NULL)
    AND ("state" IN ('UNKNOWN', 'NEEDS_ATTENTION')) = ("needsAttentionAt" IS NOT NULL)
  ),
  CONSTRAINT "CommunicationDelivery_communicationId_fkey" FOREIGN KEY ("communicationId") REFERENCES "Communication"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "CommunicationDelivery_state_nextAttemptAt_id_idx"
  ON "CommunicationDelivery" ("state", "nextAttemptAt", "id");
CREATE INDEX "CommunicationDelivery_processingLeaseUntil_id_idx"
  ON "CommunicationDelivery" ("processingLeaseUntil", "id")
  WHERE "state" = 'PROCESSING';

CREATE TABLE "CommunicationAttempt" (
  "id" BIGSERIAL NOT NULL,
  "deliveryId" BIGINT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "outcome" "CommunicationAttemptOutcome" NOT NULL DEFAULT 'PROCESSING',
  "providerMessageId" TEXT,
  "providerCode" TEXT,
  "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(6),
  CONSTRAINT "CommunicationAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommunicationAttempt_deliveryId_attemptNumber_key" UNIQUE ("deliveryId", "attemptNumber"),
  CONSTRAINT "CommunicationAttempt_attempt_number" CHECK ("attemptNumber" > 0),
  CONSTRAINT "CommunicationAttempt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "CommunicationDelivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "CommunicationAttempt_deliveryId_startedAt_idx"
  ON "CommunicationAttempt" ("deliveryId", "startedAt");
