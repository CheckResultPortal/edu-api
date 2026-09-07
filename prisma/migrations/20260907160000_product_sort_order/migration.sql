-- AlterTable
ALTER TABLE "Product" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- DropIndex
DROP INDEX IF EXISTS "Product_catalogGroupId_code_id_idx";

-- CreateIndex
CREATE INDEX "Product_catalogGroupId_sortOrder_code_id_idx" ON "Product"("catalogGroupId", "sortOrder", "code", "id");

-- Seed default display order for current WAEC checkers:
UPDATE "Product" SET "sortOrder" = 1 WHERE "code" = 'WASSCE-CHECKER';
UPDATE "Product" SET "sortOrder" = 2 WHERE "code" = 'BECE-CHECKER';
UPDATE "Product" SET "sortOrder" = 3 WHERE "code" = 'NOVDEC-CHECKER';
