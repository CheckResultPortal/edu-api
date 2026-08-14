-- Protected administrator identity: password, mandatory TOTP, opaque sessions,
-- short-lived challenges, and safe security-event records.

CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'OPERATIONS_ADMIN');
CREATE TYPE "AdminAuthChallengePurpose" AS ENUM ('TOTP_ENROLLMENT', 'TOTP_VERIFICATION');

CREATE TABLE "AdminUser" (
    "id" BIGSERIAL NOT NULL,
    "publicId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "failedAuthenticationCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(6),
    "pendingTotpSecret" JSONB,
    "totpSecret" JSONB,
    "totpEnabledAt" TIMESTAMPTZ(6),
    "passwordChangedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAuthenticatedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AdminUser_email_normalized" CHECK ("email" = lower("email")),
    CONSTRAINT "AdminUser_failedAuthenticationCount_range" CHECK ("failedAuthenticationCount" BETWEEN 0 AND 5),
    CONSTRAINT "AdminUser_passwordHash_present" CHECK (char_length("passwordHash") > 0)
);

CREATE UNIQUE INDEX "AdminUser_publicId_key" ON "AdminUser"("publicId");
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

CREATE TABLE "AdminAuthChallenge" (
    "id" BIGSERIAL NOT NULL,
    "adminUserId" BIGINT NOT NULL,
    "tokenFingerprint" TEXT NOT NULL,
    "purpose" "AdminAuthChallengePurpose" NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "failedAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuthChallenge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AdminAuthChallenge_failedAttemptCount_range" CHECK ("failedAttemptCount" BETWEEN 0 AND 5)
);

CREATE UNIQUE INDEX "AdminAuthChallenge_tokenFingerprint_key" ON "AdminAuthChallenge"("tokenFingerprint");
CREATE INDEX "AdminAuthChallenge_adminUserId_purpose_expiresAt_idx" ON "AdminAuthChallenge"("adminUserId", "purpose", "expiresAt");

CREATE TABLE "AdminSession" (
    "id" BIGSERIAL NOT NULL,
    "publicId" UUID NOT NULL,
    "adminUserId" BIGINT NOT NULL,
    "tokenFingerprint" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AdminSession_expiry_after_creation" CHECK ("expiresAt" > "createdAt")
);

CREATE UNIQUE INDEX "AdminSession_publicId_key" ON "AdminSession"("publicId");
CREATE UNIQUE INDEX "AdminSession_tokenFingerprint_key" ON "AdminSession"("tokenFingerprint");
CREATE INDEX "AdminSession_active_user_expiry_idx" ON "AdminSession"("adminUserId", "expiresAt") WHERE "revokedAt" IS NULL;

CREATE TABLE "AdminSecurityEvent" (
    "id" BIGSERIAL NOT NULL,
    "adminUserId" BIGINT,
    "eventType" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSecurityEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminSecurityEvent_adminUserId_occurredAt_idx" ON "AdminSecurityEvent"("adminUserId", "occurredAt");
CREATE INDEX "AdminSecurityEvent_eventType_occurredAt_idx" ON "AdminSecurityEvent"("eventType", "occurredAt");

ALTER TABLE "AdminAuthChallenge" ADD CONSTRAINT "AdminAuthChallenge_adminUserId_fkey"
  FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminUserId_fkey"
  FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdminSecurityEvent" ADD CONSTRAINT "AdminSecurityEvent_adminUserId_fkey"
  FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
