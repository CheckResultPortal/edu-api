-- Phase 1C guest order creation. Orders own contacts and immutable price
-- snapshots; payment success and fulfilment remain separate later units.

CREATE TABLE "Order" (
    "id" BIGSERIAL NOT NULL,
    "publicReference" UUID NOT NULL,
    "phoneNumber" TEXT,
    "email" TEXT,
    "contactAnonymizedAt" TIMESTAMPTZ(6),
    "totalPriceMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Order_totalPriceMinor_positive" CHECK ("totalPriceMinor" > 0),
    CONSTRAINT "Order_currency_ghs" CHECK ("currency" = 'GHS'),
    CONSTRAINT "Order_phone_ghana_e164" CHECK (
      "phoneNumber" IS NULL OR "phoneNumber" ~ '^\\+233[0-9]{9}$'
    ),
    CONSTRAINT "Order_email_normalized" CHECK (
      "email" IS NULL OR (
        char_length("email") BETWEEN 3 AND 320
        AND "email" = lower("email")
      )
    ),
    CONSTRAINT "Order_contact_anonymization" CHECK (
      ("contactAnonymizedAt" IS NULL AND "phoneNumber" IS NOT NULL)
      OR (
        "contactAnonymizedAt" IS NOT NULL
        AND "phoneNumber" IS NULL
        AND "email" IS NULL
      )
    )
);

CREATE UNIQUE INDEX "Order_publicReference_key"
  ON "Order"("publicReference");
CREATE INDEX "Order_createdAt_id_idx" ON "Order"("createdAt", "id");

CREATE TABLE "OrderItem" (
    "id" BIGSERIAL NOT NULL,
    "orderId" BIGINT NOT NULL,
    "productId" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceMinor" BIGINT NOT NULL,
    "totalPriceMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrderItem_quantity_range" CHECK ("quantity" BETWEEN 1 AND 20),
    CONSTRAINT "OrderItem_unitPriceMinor_positive" CHECK ("unitPriceMinor" > 0),
    CONSTRAINT "OrderItem_totalPriceMinor_positive" CHECK ("totalPriceMinor" > 0),
    CONSTRAINT "OrderItem_currency_ghs" CHECK ("currency" = 'GHS'),
    CONSTRAINT "OrderItem_total_matches_snapshot" CHECK (
      "totalPriceMinor" = "unitPriceMinor" * "quantity"
    )
);

CREATE UNIQUE INDEX "OrderItem_orderId_key" ON "OrderItem"("orderId");
CREATE INDEX "OrderItem_productId_id_idx" ON "OrderItem"("productId", "id");

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
