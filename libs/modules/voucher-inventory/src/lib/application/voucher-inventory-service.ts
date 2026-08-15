import type { Prisma } from '../../../../../../generated/prisma/client';

import type { VoucherImportCsvRow } from './voucher-import-csv';

export const VOUCHER_INVENTORY_SERVICE = Symbol('VOUCHER_INVENTORY_SERVICE');

export interface VoucherBatch {
  readonly activatedAt: Date | null;
  readonly id: bigint;
  readonly importState: 'DISCARDED' | 'FAILED' | 'IMPORTED' | 'IMPORTING';
  readonly productId: bigint;
  readonly productPublicId: string;
  readonly publicId: string;
  readonly reference: string;
  readonly totalQuantity: number;
  readonly validUntil: Date | null;
}

export interface StartVoucherBatchImportInput {
  readonly productId: bigint;
  readonly reference: string;
  readonly validUntil?: Date;
}

export interface VoucherBatchActivation {
  readonly batch: VoucherBatch;
  readonly changed: boolean;
}

export interface VoucherInventoryService {
  getBatch(batchPublicId: string): Promise<VoucherBatch>;
  startImport(
    transaction: Prisma.TransactionClient,
    input: StartVoucherBatchImportInput,
  ): Promise<VoucherBatch>;
  appendImportChunk(
    transaction: Prisma.TransactionClient,
    batchId: bigint,
    productId: bigint,
    rows: readonly VoucherImportCsvRow[],
  ): Promise<number>;
  completeImport(
    transaction: Prisma.TransactionClient,
    batchId: bigint,
  ): Promise<VoucherBatch>;
  failImport(
    transaction: Prisma.TransactionClient,
    batchId: bigint,
  ): Promise<void>;
  activateBatch(
    transaction: Prisma.TransactionClient,
    batchPublicId: string,
  ): Promise<VoucherBatchActivation>;
  discardBatchChunk(
    transaction: Prisma.TransactionClient,
    batchPublicId: string,
    limit: number,
  ): Promise<{ readonly batch: VoucherBatch; readonly complete: boolean }>;
  recoverStaleImports(limit: number): Promise<number>;
}
