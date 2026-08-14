-- Complete the protected administrator invitation flow and give durable
-- outbox consumers a recoverable, bounded claim protocol.

ALTER TABLE "AdminInvitation"
  ADD COLUMN "encryptedToken" JSONB;

ALTER TABLE "AdminInvitation"
  ADD CONSTRAINT "AdminInvitation_pending_token_present"
  CHECK (
    "acceptedAt" IS NOT NULL
    OR "revokedAt" IS NOT NULL
    OR "encryptedToken" IS NOT NULL
  );

ALTER TABLE "AdminAuthChallenge"
  ADD CONSTRAINT "AdminAuthChallenge_expiry_after_creation"
  CHECK ("expiresAt" > "createdAt");

CREATE UNIQUE INDEX "AdminAuthChallenge_one_active_per_purpose_key"
  ON "AdminAuthChallenge"("adminUserId", "purpose")
  WHERE "consumedAt" IS NULL;

ALTER TABLE "OutboxEvent"
  ADD COLUMN "lockedAt" TIMESTAMPTZ(6),
  ADD COLUMN "lockOwner" TEXT,
  ADD COLUMN "needsAttentionAt" TIMESTAMPTZ(6),
  ADD CONSTRAINT "OutboxEvent_terminal_state_check"
    CHECK ("publishedAt" IS NULL OR "needsAttentionAt" IS NULL),
  ADD CONSTRAINT "OutboxEvent_lock_state_check"
    CHECK (("lockedAt" IS NULL) = ("lockOwner" IS NULL));

CREATE INDEX "OutboxEvent_claimable_availableAt_id_idx"
  ON "OutboxEvent"("availableAt", "id")
  WHERE "publishedAt" IS NULL AND "needsAttentionAt" IS NULL;
