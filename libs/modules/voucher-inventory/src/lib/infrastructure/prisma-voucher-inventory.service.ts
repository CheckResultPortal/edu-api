import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../../../../generated/prisma/client';

import {
  encryptSecret,
  fingerprintSecret,
  type EncryptedSecret,
  type SecretKeyring,
} from '@edu-api/encryption';
import type { DatabaseClient } from '@edu-api/database';
import { assertValidOutboxEvent } from '@edu-api/outbox';

import type { VoucherImportCsvRow } from '../application/voucher-import-csv';
import {
  VoucherBatchNotFoundError,
  VoucherBatchStateError,
  VoucherImportConflictError,
  VoucherImportValidationError,
} from '../application/voucher-inventory-errors';
import type {
  StartVoucherBatchImportInput,
  VoucherBatch,
  VoucherBatchActivation,
  VoucherInventoryService,
} from '../application/voucher-inventory-service';

@Injectable()
export class PrismaVoucherInventoryService implements VoucherInventoryService {
  constructor(
    private readonly database: DatabaseClient,
    private readonly keyring: SecretKeyring,
    private readonly importStaleAfterMs: number,
  ) {}

  async getBatch(batchPublicId: string): Promise<VoucherBatch> {
    const batch = await this.database.voucherBatch.findUnique({
      where: { publicId: batchPublicId },
      select: voucherBatchSelection,
    });
    if (batch === null) {
      throw new VoucherBatchNotFoundError('Voucher batch was not found.');
    }
    return toVoucherBatch(batch);
  }

  async startImport(
    transaction: Prisma.TransactionClient,
    input: StartVoucherBatchImportInput,
  ): Promise<VoucherBatch> {
    if (input.reference.trim().length === 0 || input.reference.length > 256) {
      throw new VoucherImportValidationError(
        'Voucher batch reference must contain between 1 and 256 characters.',
      );
    }
    const batch = await transaction.voucherBatch.create({
      data: {
        productId: input.productId,
        reference: input.reference.trim(),
        ...(input.validUntil === undefined
          ? {}
          : { validUntil: input.validUntil }),
      },
      select: voucherBatchSelection,
    });
    return toVoucherBatch(batch);
  }

  async appendImportChunk(
    transaction: Prisma.TransactionClient,
    batchId: bigint,
    productId: bigint,
    rows: readonly VoucherImportCsvRow[],
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const batch = await transaction.voucherBatch.findUnique({
      where: { id: batchId },
      select: { importState: true, productId: true },
    });
    if (batch === null)
      throw new VoucherBatchNotFoundError('Voucher batch was not found.');
    if (batch.productId !== productId || batch.importState !== 'IMPORTING') {
      throw new VoucherBatchStateError(
        'Voucher batch is not accepting import rows.',
      );
    }

    const prepared = prepareRows(rows, this.keyring);
    const existing = await transaction.voucher.findFirst({
      where: {
        productId,
        OR: [
          { serialNumber: { in: prepared.map((row) => row.serialNumber) } },
          { pinFingerprint: { in: prepared.map((row) => row.pinFingerprint) } },
        ],
      },
      select: { id: true },
    });
    if (existing !== null) {
      throw new VoucherImportConflictError(
        'The import includes a serial number or PIN already present for this product.',
      );
    }

    await transaction.voucher.createMany({
      data: prepared.map((row) => ({
        batchId,
        encryptedPin: row.encryptedPin as unknown as Prisma.InputJsonValue,
        pinFingerprint: row.pinFingerprint,
        productId,
        serialNumber: row.serialNumber,
      })),
    });
    await transaction.voucherBatch.update({
      where: { id: batchId },
      data: { totalQuantity: { increment: prepared.length } },
    });
    return prepared.length;
  }

  async completeImport(
    transaction: Prisma.TransactionClient,
    batchId: bigint,
  ): Promise<VoucherBatch> {
    const batch = await this.requiredBatch(transaction, { id: batchId });
    if (batch.importState !== 'IMPORTING') {
      throw new VoucherBatchStateError('Voucher batch cannot be completed.');
    }
    if (batch.totalQuantity === 0) {
      throw new VoucherImportValidationError(
        'Voucher import must contain at least one voucher row.',
      );
    }
    const completed = await transaction.voucherBatch.update({
      where: { id: batch.id },
      data: { importState: 'IMPORTED' },
      select: voucherBatchSelection,
    });
    return toVoucherBatch(completed);
  }

  async failImport(
    transaction: Prisma.TransactionClient,
    batchId: bigint,
  ): Promise<void> {
    await transaction.voucherBatch.updateMany({
      where: { id: batchId, importState: 'IMPORTING' },
      data: { importState: 'FAILED' },
    });
  }

  async activateBatch(
    transaction: Prisma.TransactionClient,
    batchPublicId: string,
  ): Promise<VoucherBatchActivation> {
    const batch = await this.requiredBatch(transaction, {
      publicId: batchPublicId,
    });
    if (batch.activatedAt !== null)
      return { batch: toVoucherBatch(batch), changed: false };
    if (batch.importState !== 'IMPORTED') {
      throw new VoucherBatchStateError(
        'Only a completed voucher import can be activated.',
      );
    }
    const activated = await transaction.voucherBatch.update({
      where: { id: batch.id },
      data: { activatedAt: new Date() },
      select: voucherBatchSelection,
    });
    const event = {
      aggregateId: activated.id.toString(),
      aggregateType: 'VoucherBatch',
      dedupeKey: `voucher-batch-stock-added:${activated.id.toString()}`,
      eventType: 'VoucherStockAdded',
      payload: {
        batchPublicId: activated.publicId,
        productPublicId: activated.product.publicId,
        quantity: activated.totalQuantity,
        version: 1,
      },
    } as const;
    assertValidOutboxEvent(event);
    await transaction.outboxEvent.create({
      data: {
        aggregateId: activated.id,
        aggregateType: event.aggregateType,
        dedupeKey: event.dedupeKey,
        eventType: event.eventType,
        payload: event.payload,
      },
    });
    return { batch: toVoucherBatch(activated), changed: true };
  }

  async discardBatchChunk(
    transaction: Prisma.TransactionClient,
    batchPublicId: string,
    limit: number,
  ): Promise<{ readonly batch: VoucherBatch; readonly complete: boolean }> {
    const batch = await this.requiredBatch(transaction, {
      publicId: batchPublicId,
    });
    if (batch.activatedAt !== null) {
      throw new VoucherBatchStateError(
        'An activated voucher batch cannot be discarded.',
      );
    }
    if (batch.importState === 'DISCARDED') {
      return { batch: toVoucherBatch(batch), complete: true };
    }
    if (batch.importState === 'IMPORTING' || batch.importState === 'IMPORTED') {
      await transaction.voucherBatch.update({
        where: { id: batch.id },
        data: { importState: 'FAILED' },
      });
    }
    const vouchers = await transaction.voucher.findMany({
      where: { batchId: batch.id },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true },
    });
    if (vouchers.length !== 0) {
      await transaction.voucher.deleteMany({
        where: { id: { in: vouchers.map((voucher) => voucher.id) } },
      });
      const current = await this.requiredBatch(transaction, { id: batch.id });
      return { batch: toVoucherBatch(current), complete: false };
    }
    const discarded = await transaction.voucherBatch.update({
      where: { id: batch.id },
      data: { importState: 'DISCARDED', totalQuantity: 0 },
      select: voucherBatchSelection,
    });
    return { batch: toVoucherBatch(discarded), complete: true };
  }

  async recoverStaleImports(limit: number): Promise<number> {
    const staleBefore = new Date(Date.now() - this.importStaleAfterMs);
    const batches = await this.database.voucherBatch.findMany({
      where: { importState: 'IMPORTING', updatedAt: { lt: staleBefore } },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    if (batches.length === 0) return 0;
    const result = await this.database.voucherBatch.updateMany({
      where: {
        id: { in: batches.map((batch) => batch.id) },
        importState: 'IMPORTING',
      },
      data: { importState: 'FAILED' },
    });
    return result.count;
  }

  private async requiredBatch(
    transaction: Prisma.TransactionClient,
    where: { readonly id: bigint } | { readonly publicId: string },
  ) {
    const batch = await transaction.voucherBatch.findUnique({
      where,
      select: voucherBatchSelection,
    });
    if (batch === null)
      throw new VoucherBatchNotFoundError('Voucher batch was not found.');
    return batch;
  }
}

const voucherBatchSelection = {
  id: true,
  publicId: true,
  productId: true,
  reference: true,
  validUntil: true,
  importState: true,
  totalQuantity: true,
  activatedAt: true,
  product: { select: { publicId: true } },
} as const;

function prepareRows(
  rows: readonly VoucherImportCsvRow[],
  keyring: SecretKeyring,
) {
  const serials = new Set<string>();
  const fingerprints = new Set<string>();
  return rows.map((row) => {
    const pinFingerprint = fingerprintSecret(row.pin, keyring);
    if (serials.has(row.serialNumber) || fingerprints.has(pinFingerprint)) {
      throw new VoucherImportConflictError(
        `Voucher import contains a duplicate serial number or PIN at row ${row.rowNumber}.`,
      );
    }
    serials.add(row.serialNumber);
    fingerprints.add(pinFingerprint);
    const encryptedPin: EncryptedSecret = encryptSecret(row.pin, keyring);
    return { encryptedPin, pinFingerprint, serialNumber: row.serialNumber };
  });
}

function toVoucherBatch(batch: {
  readonly activatedAt: Date | null;
  readonly id: bigint;
  readonly importState: 'DISCARDED' | 'FAILED' | 'IMPORTED' | 'IMPORTING';
  readonly productId: bigint;
  readonly product: { readonly publicId: string };
  readonly publicId: string;
  readonly reference: string;
  readonly totalQuantity: number;
  readonly validUntil: Date | null;
}): VoucherBatch {
  return {
    activatedAt: batch.activatedAt,
    id: batch.id,
    importState: batch.importState,
    productId: batch.productId,
    productPublicId: batch.product.publicId,
    publicId: batch.publicId,
    reference: batch.reference,
    totalQuantity: batch.totalQuantity,
    validUntil: batch.validUntil,
  };
}
