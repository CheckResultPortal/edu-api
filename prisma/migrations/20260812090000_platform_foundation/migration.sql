-- Platform foundation for durable events and idempotent public operations.
-- Domain writes insert OutboxEvent rows in the same transaction. Payloads must
-- contain safe references/metadata only; secrets and voucher PINs are forbidden.

CREATE TYPE "IdempotencyStatus" AS ENUM ('PROCESSING', 'COMPLETED');

CREATE TABLE "OutboxEvent" (
    "id" BIGSERIAL NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" BIGINT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastFailureCode" TEXT,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OutboxEvent_attempts_nonnegative" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "OutboxEvent_dedupeKey_key" ON "OutboxEvent"("dedupeKey");
CREATE INDEX "OutboxEvent_pending_availableAt_id_idx"
    ON "OutboxEvent"("availableAt", "id")
    WHERE "publishedAt" IS NULL;

CREATE TABLE "IdempotencyRecord" (
    "id" BIGSERIAL NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'PROCESSING',
    "responseStatus" INTEGER,
    "responseReference" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IdempotencyRecord_scope_key_key" UNIQUE ("scope", "key"),
    CONSTRAINT "IdempotencyRecord_completed_response_check"
        CHECK (
          ("status" = 'PROCESSING' AND "completedAt" IS NULL)
          OR ("status" = 'COMPLETED' AND "completedAt" IS NOT NULL)
        )
);

CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");
