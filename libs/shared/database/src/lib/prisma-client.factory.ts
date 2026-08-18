import { PrismaPg } from '@prisma/adapter-pg';
import type { Prisma } from '../../../../../generated/prisma/client';

import { databaseUrlFromEnvironment } from './database-url';

export type DatabaseTransactionClient = Prisma.TransactionClient;

export async function createPrismaClient(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const { PrismaClient } = await import(
    '../../../../../generated/prisma/client'
  );
  const adapter = new PrismaPg({
    connectionString: databaseUrlFromEnvironment(environment),
  });

  return new PrismaClient({ adapter });
}
