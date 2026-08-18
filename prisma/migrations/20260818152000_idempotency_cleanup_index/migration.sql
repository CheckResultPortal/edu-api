-- Support bounded, scope-owned expiry cleanup without scanning the durable
-- idempotency history.

BEGIN;

DROP INDEX "IdempotencyRecord_expiresAt_idx";

CREATE INDEX "IdempotencyRecord_scope_expiresAt_id_idx"
  ON "IdempotencyRecord"("scope", "expiresAt", "id");

COMMIT;
