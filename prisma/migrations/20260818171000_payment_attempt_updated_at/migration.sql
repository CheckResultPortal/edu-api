-- Match Prisma's @updatedAt contract: application writes the initial value and
-- every subsequent update; PostgreSQL must not manufacture an independent one.
ALTER TABLE "PaymentAttempt"
  ALTER COLUMN "updatedAt" DROP DEFAULT;
