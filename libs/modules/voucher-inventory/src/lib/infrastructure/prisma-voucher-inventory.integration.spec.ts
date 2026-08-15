import { randomBytes, randomUUID } from 'node:crypto';

import { createPrismaClient, type DatabaseClient } from '@edu-api/database';
import { createSecretKeyring } from '@edu-api/encryption';

import type { VoucherImportCsvRow } from '../application/voucher-import-csv';
import { VoucherImportConflictError } from '../application/voucher-inventory-errors';
import { PrismaVoucherInventoryService } from './prisma-voucher-inventory.service';

const databaseUrl = process.env.VOUCHER_INVENTORY_TEST_DATABASE_URL;
const describeWithDatabase =
  databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('PrismaVoucherInventoryService (PostgreSQL)', () => {
  let database: DatabaseClient;
  let productId: bigint;
  let suffix: string;
  let service: PrismaVoucherInventoryService;

  beforeAll(async () => {
    database = await createPrismaClient({ DATABASE_URL: databaseUrl });
    const keyring = createSecretKeyring({
      activeKeyId: 'test-v1',
      fingerprintKey: randomBytes(32),
      keys: [{ id: 'test-v1', material: randomBytes(32) }],
    });
    service = new PrismaVoucherInventoryService(database, keyring, 60_000);
  });

  beforeEach(async () => {
    suffix = randomUUID().replace(/-/g, '').toUpperCase();
    const group = await database.catalogGroup.create({
      data: { code: `INVENTORY_${suffix}`, name: 'Inventory', sortOrder: 0 },
      select: { id: true },
    });
    const product = await database.product.create({
      data: {
        catalogGroupId: group.id,
        code: `VOUCHER_${suffix}`,
        currency: 'GHS',
        lowStockThreshold: 1,
        name: 'Voucher product',
        sellingPriceMinor: BigInt(100),
      },
      select: { id: true },
    });
    productId = product.id;
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
        where: { aggregateType: 'VoucherBatch', aggregateId: { in: batchIds } },
      });
      await database.voucherBatch.deleteMany({
        where: { id: { in: batchIds } },
      });
    }
    await database.product.delete({ where: { id: productId } });
    await database.catalogGroup.deleteMany({
      where: { code: `INVENTORY_${suffix}` },
    });
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it('encrypts imports, rejects duplicate credentials, and emits one stock event on activation', async () => {
    const batch = await database.$transaction((transaction) =>
      service.startImport(transaction, {
        productId,
        reference: 'supplier-delivery-001',
      }),
    );
    const rows: readonly VoucherImportCsvRow[] = [
      { pin: 'PIN-ONE', rowNumber: 2, serialNumber: 'SERIAL-ONE' },
      { pin: 'PIN-TWO', rowNumber: 3, serialNumber: 'SERIAL-TWO' },
    ];
    await database.$transaction((transaction) =>
      service.appendImportChunk(transaction, batch.id, productId, rows),
    );
    const completed = await database.$transaction((transaction) =>
      service.completeImport(transaction, batch.id),
    );
    expect(completed).toMatchObject({
      importState: 'IMPORTED',
      totalQuantity: 2,
    });

    const storedVoucher = await database.voucher.findUniqueOrThrow({
      where: {
        productId_serialNumber: { productId, serialNumber: 'SERIAL-ONE' },
      },
      select: { encryptedPin: true, pinFingerprint: true, status: true },
    });
    expect(JSON.stringify(storedVoucher.encryptedPin)).not.toContain('PIN-ONE');
    expect(storedVoucher.pinFingerprint).not.toBe('PIN-ONE');
    expect(storedVoucher.status).toBe('AVAILABLE');

    await expect(
      database.$transaction((transaction) =>
        service.appendImportChunk(transaction, batch.id, productId, rows),
      ),
    ).rejects.toBeInstanceOf(Error);

    const activated = await database.$transaction((transaction) =>
      service.activateBatch(transaction, batch.publicId),
    );
    const repeated = await database.$transaction((transaction) =>
      service.activateBatch(transaction, batch.publicId),
    );
    expect(activated.changed).toBe(true);
    expect(repeated.changed).toBe(false);
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

  it('rejects duplicate serials within a chunk before persistence', async () => {
    const batch = await database.$transaction((transaction) =>
      service.startImport(transaction, { productId, reference: 'duplicates' }),
    );
    await expect(
      database.$transaction((transaction) =>
        service.appendImportChunk(transaction, batch.id, productId, [
          { pin: 'PIN-ONE', rowNumber: 2, serialNumber: 'SERIAL-ONE' },
          { pin: 'PIN-TWO', rowNumber: 3, serialNumber: 'SERIAL-ONE' },
        ]),
      ),
    ).rejects.toBeInstanceOf(VoucherImportConflictError);
    await expect(
      database.voucher.count({ where: { batchId: batch.id } }),
    ).resolves.toBe(0);
  });
});
