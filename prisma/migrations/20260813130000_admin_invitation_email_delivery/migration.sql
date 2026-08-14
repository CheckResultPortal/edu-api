-- Communication-owned delivery and immutable attempt records for the
-- administrator invitation flow. This does not participate in voucher stock.

CREATE TYPE "EmailDeliveryState" AS ENUM (
  'PENDING', 'PROCESSING', 'RETRYING', 'SENT', 'NEEDS_ATTENTION'
);

CREATE TYPE "EmailAttemptOutcome" AS ENUM (
  'PROCESSING', 'SENT', 'TEMPORARY', 'PERMANENT', 'RATE_LIMITED',
  'AUTHENTICATION', 'INVALID_REQUEST', 'UNKNOWN_OUTCOME'
);

CREATE TABLE "AdminInvitationEmailDelivery" (
  "id" BIGSERIAL NOT NULL,
  "publicId" UUID NOT NULL,
  "invitationId" BIGINT NOT NULL,
  "destinationEmail" TEXT NOT NULL,
  "state" "EmailDeliveryState" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processingStartedAt" TIMESTAMPTZ(6),
  "providerMessageId" TEXT,
  "lastFailureCategory" TEXT,
  "needsAttentionAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AdminInvitationEmailDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdminInvitationEmailDelivery_attemptCount_nonnegative" CHECK ("attemptCount" >= 0),
  CONSTRAINT "AdminInvitationEmailDelivery_terminal_state" CHECK (
    "state" <> 'SENT' OR "providerMessageId" IS NOT NULL
  ),
  CONSTRAINT "AdminInvitationEmailDelivery_attention_state" CHECK (
    "state" = 'NEEDS_ATTENTION' OR "needsAttentionAt" IS NULL
  )
);

CREATE UNIQUE INDEX "AdminInvitationEmailDelivery_publicId_key"
  ON "AdminInvitationEmailDelivery"("publicId");
CREATE UNIQUE INDEX "AdminInvitationEmailDelivery_invitationId_key"
  ON "AdminInvitationEmailDelivery"("invitationId");
CREATE INDEX "AdminInvitationEmailDelivery_state_nextAttemptAt_id_idx"
  ON "AdminInvitationEmailDelivery"("state", "nextAttemptAt", "id");

CREATE TABLE "AdminInvitationEmailAttempt" (
  "id" BIGSERIAL NOT NULL,
  "deliveryId" BIGINT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "outcome" "EmailAttemptOutcome" NOT NULL DEFAULT 'PROCESSING',
  "providerMessageId" TEXT,
  "providerCode" TEXT,
  "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(6),

  CONSTRAINT "AdminInvitationEmailAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdminInvitationEmailAttempt_attemptNumber_positive" CHECK ("attemptNumber" > 0),
  CONSTRAINT "AdminInvitationEmailAttempt_completion" CHECK (
    ("outcome" = 'PROCESSING' AND "completedAt" IS NULL)
    OR ("outcome" <> 'PROCESSING' AND "completedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "AdminInvitationEmailAttempt_deliveryId_attemptNumber_key"
  ON "AdminInvitationEmailAttempt"("deliveryId", "attemptNumber");
CREATE INDEX "AdminInvitationEmailAttempt_deliveryId_startedAt_idx"
  ON "AdminInvitationEmailAttempt"("deliveryId", "startedAt");

ALTER TABLE "AdminInvitationEmailDelivery"
  ADD CONSTRAINT "AdminInvitationEmailDelivery_invitationId_fkey"
  FOREIGN KEY ("invitationId") REFERENCES "AdminInvitation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AdminInvitationEmailAttempt"
  ADD CONSTRAINT "AdminInvitationEmailAttempt_deliveryId_fkey"
  FOREIGN KEY ("deliveryId") REFERENCES "AdminInvitationEmailDelivery"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
