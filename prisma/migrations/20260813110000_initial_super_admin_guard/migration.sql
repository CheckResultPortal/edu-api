-- The bootstrap command can establish the one-and-only initial Super Admin.
-- All later administrators must use the Super-Admin invitation flow.

ALTER TABLE "AdminUser"
  ADD COLUMN "isInitialSuperAdmin" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "AdminUser_single_initial_super_admin_key"
  ON "AdminUser"("isInitialSuperAdmin")
  WHERE "isInitialSuperAdmin" = true;
