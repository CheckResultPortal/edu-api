-- One-time administrator password-reset bearer records. The bearer itself is
-- kept encrypted for the delivery worker; redemption uses only its HMAC.

CREATE TABLE "AdminPasswordReset" (
    "id" BIGSERIAL NOT NULL,
    "publicId" UUID NOT NULL,
    "adminUserId" BIGINT NOT NULL,
    "tokenFingerprint" TEXT NOT NULL,
    "encryptedToken" JSONB,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminPasswordReset_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AdminPasswordReset_terminal_state" CHECK (
      NOT ("consumedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "AdminPasswordReset_publicId_key"
  ON "AdminPasswordReset"("publicId");
CREATE UNIQUE INDEX "AdminPasswordReset_tokenFingerprint_key"
  ON "AdminPasswordReset"("tokenFingerprint");
CREATE INDEX "AdminPasswordReset_adminUserId_expiresAt_idx"
  ON "AdminPasswordReset"("adminUserId", "expiresAt");

ALTER TABLE "AdminPasswordReset"
  ADD CONSTRAINT "AdminPasswordReset_adminUserId_fkey"
  FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
