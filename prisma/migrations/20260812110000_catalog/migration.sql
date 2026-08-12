-- Phase 1A Catalog: flexible grouping hierarchy and authoritative product data.

CREATE TABLE "CatalogGroup" (
    "id" BIGSERIAL NOT NULL,
    "publicId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" BIGINT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogGroup_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CatalogGroup_parent_not_self" CHECK ("parentId" IS NULL OR "parentId" <> "id"),
    CONSTRAINT "CatalogGroup_sortOrder_nonnegative" CHECK ("sortOrder" >= 0)
);

CREATE UNIQUE INDEX "CatalogGroup_publicId_key" ON "CatalogGroup"("publicId");
CREATE UNIQUE INDEX "CatalogGroup_code_key" ON "CatalogGroup"("code");
CREATE INDEX "CatalogGroup_parentId_sortOrder_id_idx" ON "CatalogGroup"("parentId", "sortOrder", "id");

ALTER TABLE "CatalogGroup"
  ADD CONSTRAINT "CatalogGroup_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "CatalogGroup"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Product" (
    "id" BIGSERIAL NOT NULL,
    "publicId" UUID NOT NULL,
    "catalogGroupId" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sellingPriceMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "resultCheckerUrl" TEXT,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Product_sellingPriceMinor_positive" CHECK ("sellingPriceMinor" > 0),
    CONSTRAINT "Product_currency_iso_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "Product_lowStockThreshold_nonnegative" CHECK ("lowStockThreshold" >= 0)
);

CREATE UNIQUE INDEX "Product_publicId_key" ON "Product"("publicId");
CREATE UNIQUE INDEX "Product_code_key" ON "Product"("code");
CREATE INDEX "Product_catalogGroupId_code_id_idx" ON "Product"("catalogGroupId", "code", "id");
CREATE INDEX "Product_active_code_id_idx" ON "Product"("code", "id") WHERE "isActive" = true;

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_catalogGroupId_fkey"
  FOREIGN KEY ("catalogGroupId") REFERENCES "CatalogGroup"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
