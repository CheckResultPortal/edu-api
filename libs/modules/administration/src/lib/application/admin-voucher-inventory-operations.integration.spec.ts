import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type { ConfigService } from '@nestjs/config';

import { createPrismaClient, type DatabaseClient } from '@edu-api/database';
import { createSecretKeyring } from '@edu-api/encryption';
import { PrismaCatalogProductReferenceQuery } from '@edu-api/catalog';
import { PrismaVoucherInventoryService } from '@edu-api/voucher-inventory';

import type { AuthenticatedAdmin } from './administration-types';
import { PrismaAdminVoucherInventoryOperationsService } from './admin-voucher-inventory-operations';

const databaseUrl = process.env.ADMIN_VOUCHER_INVENTORY_TEST_DATABASE_URL;
const describeWithDatabase =
  databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase(
  'PrismaAdminVoucherInventoryOperationsService (PostgreSQL)',
  () => {
    let actor: AuthenticatedAdmin;
    let database: DatabaseClient;
    let operations: PrismaAdminVoucherInventoryOperationsService;
    let productId: bigint;
    let productPublicId: string;
    let suffix: string;

    beforeAll(async () => {
      database = await createPrismaClient({ DATABASE_URL: databaseUrl });
      const inventory = new PrismaVoucherInventoryService(
        database,
        createSecretKeyring({
          activeKeyId: 'test-v1',
          fingerprintKey: randomBytes(32),
          keys: [{ id: 'test-v1', material: randomBytes(32) }],
        }),
        60_000,
      );
      const config = {
        getOrThrow: <T>(name: string): T =>
          (name === 'VOUCHER_IMPORT_CHUNK_SIZE' ? 2 : 10_000) as T,
      } as ConfigService;
      operations = new PrismaAdminVoucherInventoryOperationsService(
        database,
        new PrismaCatalogProductReferenceQuery(database),
        inventory,
        config,
      );
    });

    beforeEach(async () => {
      suffix = randomUUID().replace(/-/g, '').toUpperCase();
      const administrator = await database.adminUser.create({
        data: {
          email: `inventory-${suffix.toLowerCase()}@integration.test`,
          passwordHash: 'integration-test-password-hash',
          role: 'OPERATIONS_ADMIN',
        },
        select: { id: true, publicId: true },
      });
      actor = {
        id: administrator.id,
        publicId: administrator.publicId,
        role: 'OPERATIONS_ADMIN',
        sessionId: BigInt(0),
      };
      const group = await database.catalogGroup.create({
        data: {
          code: `ADMIN_INV_${suffix}`,
          name: 'Admin inventory',
          sortOrder: 0,
        },
        select: { id: true },
      });
      const product = await database.product.create({
        data: {
          catalogGroupId: group.id,
          code: `ADMIN_VOUCHER_${suffix}`,
          currency: 'GHS',
          lowStockThreshold: 5,
          name: 'Admin voucher product',
          sellingPriceMinor: BigInt(2500),
        },
        select: { id: true, publicId: true },
      });
      productId = product.id;
      productPublicId = product.publicId;
    });

    afterEach(async () => {
      const batches = await database.voucherBatch.findMany({
        where: { productId },
        select: { id: true },
      });
      const batchIds = batches.map((batch) => batch.id);
      if (batchIds.length !== 0) {
        await database.voucher.deleteMany({
          where: { batchId: { in: batchIds } },
        });
        await database.outboxEvent.deleteMany({
          where: {
            aggregateType: 'VoucherBatch',
            aggregateId: { in: batchIds },
          },
        });
        await database.voucherBatch.deleteMany({
          where: { id: { in: batchIds } },
        });
      }
      await database.product.delete({ where: { id: productId } });
      await database.catalogGroup.deleteMany({
        where: { code: `ADMIN_INV_${suffix}` },
      });
      await database.adminSecurityEvent.deleteMany({
        where: { adminUserId: actor.id },
      });
      await database.adminUser.delete({ where: { id: actor.id } });
    });

    afterAll(async () => {
      await database.$disconnect();
    });

    it('commits batch lifecycle facts, audit records, and the stock event without exposing the PIN', async () => {
      const source = Readable.from([
        Buffer.from('serialNumber,pin\nSERIAL-ONE,PIN-ONE\n'),
        Buffer.from('SERIAL-TWO,PIN-TWO\n'),
      ]);
      const batch = await operations.importCsv(
        actor,
        {
          productPublicId,
          reference: 'supplier-reference-001',
          source,
        },
        { correlationId: 'voucher-import' },
      );

      expect(batch).toMatchObject({
        importState: 'IMPORTED',
        productPublicId,
        totalQuantity: 2,
      });
      const auditedImport = await database.adminSecurityEvent.findMany({
        where: { adminUserId: actor.id, correlationId: 'voucher-import' },
        orderBy: { occurredAt: 'asc' },
        select: { eventType: true, metadata: true },
      });
      expect(auditedImport.map((event) => event.eventType)).toEqual([
        'VOUCHER_BATCH_IMPORT_STARTED',
        'VOUCHER_BATCH_IMPORT_COMPLETED',
      ]);
      expect(JSON.stringify(auditedImport)).not.toContain('PIN-ONE');

      const activation = await operations.activateBatch(actor, batch.publicId, {
        correlationId: 'voucher-activate',
      });
      expect(activation.changed).toBe(true);
      await expect(
        operations.getBatch(actor, batch.publicId),
      ).resolves.toMatchObject({
        activatedAt: expect.any(Date),
        importState: 'IMPORTED',
      });
      await expect(
        database.outboxEvent.count({
          where: {
            aggregateId: batch.id,
            aggregateType: 'VoucherBatch',
            eventType: 'VoucherStockAdded',
          },
        }),
      ).resolves.toBe(1);
    });
  },
);
