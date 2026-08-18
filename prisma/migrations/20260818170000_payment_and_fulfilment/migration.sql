-- Phase 1D verified web payment attempts and durable paid obligations.
-- All changes are additive; financial and fulfilment history must be retained.

CREATE TYPE "PaymentAttemptStatus" AS ENUM (
  'INITIALIZING',
  'PENDING',
  'UNKNOWN',
  'SUCCEEDED',
  'FAILED'
);

CREATE TYPE "PaymentProviderEventOutcome" AS ENUM (
  'APPLIED',
  'REJECTED',
  'ADDITIONAL_SUCCESS'
);

CREATE UNIQUE INDEX "OrderItem_id_productId_key"
  ON "OrderItem"("id", "productId");

CREATE TABLE "PaymentAttempt" (
  "id" BIGSERIAL NOT NULL,
  "publicReference" UUID NOT NULL,
  "orderId" BIGINT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerReference" TEXT NOT NULL,
  "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'INITIALIZING',
  "expectedAmountMinor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "authorizationUrl" TEXT,
  "accessCode" TEXT,
  "providerTransactionId" TEXT,
  "providerStatus" TEXT,
  "paidAt" TIMESTAMPTZ(6),
  "verifiedAt" TIMESTAMPTZ(6),
  "nextVerificationAt" TIMESTAMPTZ(6),
  "verificationLeaseUntil" TIMESTAMPTZ(6),
  "verificationAttempts" INTEGER NOT NULL DEFAULT 0,
  "needsAttentionAt" TIMESTAMPTZ(6),
  "attentionReason" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentAttempt_provider_format" CHECK (
    "provider" ~ '^[A-Z][A-Z0-9_]{1,31}$'
  ),
  CONSTRAINT "PaymentAttempt_providerReference_bounds" CHECK (
    char_length("providerReference") BETWEEN 1 AND 200
  ),
  CONSTRAINT "PaymentAttempt_amount_positive" CHECK (
    "expectedAmountMinor" > 0
  ),
  CONSTRAINT "PaymentAttempt_currency_ghs" CHECK ("currency" = 'GHS'),
  CONSTRAINT "PaymentAttempt_authorizationUrl_bounds" CHECK (
    "authorizationUrl" IS NULL
    OR char_length("authorizationUrl") BETWEEN 1 AND 2048
  ),
  CONSTRAINT "PaymentAttempt_accessCode_bounds" CHECK (
    "accessCode" IS NULL OR char_length("accessCode") BETWEEN 1 AND 256
  ),
  CONSTRAINT "PaymentAttempt_providerTransactionId_bounds" CHECK (
    "providerTransactionId" IS NULL
    OR char_length("providerTransactionId") BETWEEN 1 AND 100
  ),
  CONSTRAINT "PaymentAttempt_providerStatus_bounds" CHECK (
    "providerStatus" IS NULL
    OR char_length("providerStatus") BETWEEN 1 AND 100
  ),
  CONSTRAINT "PaymentAttempt_attention_shape" CHECK (
    ("needsAttentionAt" IS NULL AND "attentionReason" IS NULL)
    OR (
      "needsAttentionAt" IS NOT NULL
      AND char_length("attentionReason") BETWEEN 1 AND 100
    )
  ),
  CONSTRAINT "PaymentAttempt_verificationAttempts_nonnegative" CHECK (
    "verificationAttempts" >= 0
  ),
  CONSTRAINT "PaymentAttempt_success_shape" CHECK (
    "status" <> 'SUCCEEDED'
    OR (
      "paidAt" IS NOT NULL
      AND "verifiedAt" IS NOT NULL
      AND "providerTransactionId" IS NOT NULL
      AND "providerStatus" IS NOT NULL
    )
  ),
  CONSTRAINT "PaymentAttempt_recovery_shape" CHECK (
    (
      "status" IN ('INITIALIZING', 'PENDING', 'UNKNOWN')
      AND ("nextVerificationAt" IS NOT NULL OR "needsAttentionAt" IS NOT NULL)
    )
    OR (
      "status" IN ('SUCCEEDED', 'FAILED')
      AND "nextVerificationAt" IS NULL
      AND "verificationLeaseUntil" IS NULL
    )
  )
);

CREATE UNIQUE INDEX "PaymentAttempt_publicReference_key"
  ON "PaymentAttempt"("publicReference");
CREATE UNIQUE INDEX "PaymentAttempt_provider_providerReference_key"
  ON "PaymentAttempt"("provider", "providerReference");
CREATE UNIQUE INDEX "PaymentAttempt_provider_providerTransactionId_key"
  ON "PaymentAttempt"("provider", "providerTransactionId");
CREATE INDEX "PaymentAttempt_orderId_createdAt_id_idx"
  ON "PaymentAttempt"("orderId", "createdAt", "id");
CREATE INDEX "PaymentAttempt_status_nextVerificationAt_id_idx"
  ON "PaymentAttempt"("status", "nextVerificationAt", "id");
CREATE INDEX "PaymentAttempt_recovery_due_idx"
  ON "PaymentAttempt"("nextVerificationAt", "id")
  WHERE "status" IN ('INITIALIZING', 'PENDING', 'UNKNOWN')
    AND "nextVerificationAt" IS NOT NULL;

CREATE TABLE "PaymentProviderEvent" (
  "id" BIGSERIAL NOT NULL,
  "paymentAttemptId" BIGINT,
  "provider" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "providerReference" TEXT NOT NULL,
  "providerTransactionId" TEXT,
  "payloadFingerprint" TEXT NOT NULL,
  "outcome" "PaymentProviderEventOutcome" NOT NULL,
  "rejectionReason" TEXT,
  "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PaymentProviderEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentProviderEvent_provider_format" CHECK (
    "provider" ~ '^[A-Z][A-Z0-9_]{1,31}$'
  ),
  CONSTRAINT "PaymentProviderEvent_eventType_bounds" CHECK (
    char_length("eventType") BETWEEN 1 AND 100
  ),
  CONSTRAINT "PaymentProviderEvent_reference_bounds" CHECK (
    char_length("providerReference") BETWEEN 1 AND 200
  ),
  CONSTRAINT "PaymentProviderEvent_transactionId_bounds" CHECK (
    "providerTransactionId" IS NULL
    OR char_length("providerTransactionId") BETWEEN 1 AND 100
  ),
  CONSTRAINT "PaymentProviderEvent_fingerprint_sha256" CHECK (
    "payloadFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "PaymentProviderEvent_outcome_shape" CHECK (
    ("outcome" = 'REJECTED' AND char_length("rejectionReason") BETWEEN 1 AND 100)
    OR ("outcome" <> 'REJECTED' AND "rejectionReason" IS NULL)
  )
);

CREATE UNIQUE INDEX "PaymentProviderEvent_provider_eventType_providerReference_key"
  ON "PaymentProviderEvent"("provider", "eventType", "providerReference");
CREATE UNIQUE INDEX "PaymentProviderEvent_provider_payloadFingerprint_key"
  ON "PaymentProviderEvent"("provider", "payloadFingerprint");
CREATE INDEX "PaymentProviderEvent_paymentAttemptId_receivedAt_id_idx"
  ON "PaymentProviderEvent"("paymentAttemptId", "receivedAt", "id");
CREATE INDEX "PaymentProviderEvent_outcome_receivedAt_id_idx"
  ON "PaymentProviderEvent"("outcome", "receivedAt", "id");

CREATE TABLE "PaymentApplication" (
  "id" BIGSERIAL NOT NULL,
  "orderId" BIGINT NOT NULL,
  "paymentAttemptId" BIGINT NOT NULL,
  "appliedAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PaymentApplication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentApplication_orderId_key"
  ON "PaymentApplication"("orderId");
CREATE UNIQUE INDEX "PaymentApplication_paymentAttemptId_key"
  ON "PaymentApplication"("paymentAttemptId");

CREATE TABLE "FulfilmentUnit" (
  "id" BIGSERIAL NOT NULL,
  "publicReference" UUID NOT NULL,
  "paymentApplicationId" BIGINT NOT NULL,
  "orderItemId" BIGINT NOT NULL,
  "productId" BIGINT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "paidAt" TIMESTAMPTZ(6) NOT NULL,
  "allocatedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FulfilmentUnit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FulfilmentUnit_ordinal_range" CHECK (
    "ordinal" BETWEEN 1 AND 20
  ),
  CONSTRAINT "FulfilmentUnit_allocation_after_payment" CHECK (
    "allocatedAt" IS NULL OR "allocatedAt" >= "paidAt"
  )
);

CREATE UNIQUE INDEX "FulfilmentUnit_publicReference_key"
  ON "FulfilmentUnit"("publicReference");
CREATE UNIQUE INDEX "FulfilmentUnit_orderItemId_ordinal_key"
  ON "FulfilmentUnit"("orderItemId", "ordinal");
CREATE INDEX "FulfilmentUnit_paymentApplicationId_id_idx"
  ON "FulfilmentUnit"("paymentApplicationId", "id");
CREATE INDEX "FulfilmentUnit_paidAt_id_idx"
  ON "FulfilmentUnit"("paidAt", "id");
CREATE INDEX "FulfilmentUnit_productId_allocatedAt_paidAt_id_idx"
  ON "FulfilmentUnit"("productId", "allocatedAt", "paidAt", "id");
CREATE INDEX "FulfilmentUnit_waiting_fifo_idx"
  ON "FulfilmentUnit"("productId", "paidAt", "id")
  WHERE "allocatedAt" IS NULL;

ALTER TABLE "PaymentAttempt"
  ADD CONSTRAINT "PaymentAttempt_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentProviderEvent"
  ADD CONSTRAINT "PaymentProviderEvent_paymentAttemptId_fkey"
  FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentApplication"
  ADD CONSTRAINT "PaymentApplication_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentApplication"
  ADD CONSTRAINT "PaymentApplication_paymentAttemptId_fkey"
  FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FulfilmentUnit"
  ADD CONSTRAINT "FulfilmentUnit_paymentApplicationId_fkey"
  FOREIGN KEY ("paymentApplicationId") REFERENCES "PaymentApplication"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FulfilmentUnit"
  ADD CONSTRAINT "FulfilmentUnit_orderItemId_productId_fkey"
  FOREIGN KEY ("orderItemId", "productId")
  REFERENCES "OrderItem"("id", "productId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FulfilmentUnit"
  ADD CONSTRAINT "FulfilmentUnit_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
