-- Super-Admin-owned, single-use administrator invitations. A live invitation
-- reserves activeEmail; resend/revoke/accept clears it before another invite.

CREATE TABLE "AdminInvitation" (
    "id" BIGSERIAL NOT NULL,
    "publicId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "activeEmail" TEXT,
    "role" "AdminRole" NOT NULL,
    "tokenFingerprint" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "invitedByAdminUserId" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminInvitation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AdminInvitation_email_normalized" CHECK ("email" = lower("email")),
    CONSTRAINT "AdminInvitation_expiry_after_creation" CHECK ("expiresAt" > "createdAt"),
    CONSTRAINT "AdminInvitation_terminal_state" CHECK ("acceptedAt" IS NULL OR "revokedAt" IS NULL)
);

CREATE UNIQUE INDEX "AdminInvitation_publicId_key" ON "AdminInvitation"("publicId");
CREATE UNIQUE INDEX "AdminInvitation_activeEmail_key" ON "AdminInvitation"("activeEmail");
CREATE UNIQUE INDEX "AdminInvitation_tokenFingerprint_key" ON "AdminInvitation"("tokenFingerprint");
CREATE INDEX "AdminInvitation_email_expiresAt_idx" ON "AdminInvitation"("email", "expiresAt");

ALTER TABLE "AdminInvitation" ADD CONSTRAINT "AdminInvitation_invitedByAdminUserId_fkey"
  FOREIGN KEY ("invitedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
