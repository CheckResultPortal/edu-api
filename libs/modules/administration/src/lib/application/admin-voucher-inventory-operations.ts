import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../../../../generated/prisma/client';

import type { ConfigService } from '@nestjs/config';

import {
  CATALOG_PRODUCT_REFERENCE_QUERY,
  type CatalogProductReferenceQuery,
} from '@edu-api/catalog';
import type { DatabaseClient } from '@edu-api/database';
import {
  readVoucherImportCsv,
  type VoucherBatch,
  VoucherImportConflictError,
  type VoucherInventoryService,
  VOUCHER_INVENTORY_SERVICE,
} from '@edu-api/voucher-inventory';

import { AdminAuthorizationError } from './admin-identity-errors';
import type {
  AuthenticatedAdmin,
  RequestContext,
} from './administration-types';

export const ADMIN_VOUCHER_INVENTORY_OPERATIONS_SERVICE = Symbol(
  'ADMIN_VOUCHER_INVENTORY_OPERATIONS_SERVICE',
);

export interface ImportVoucherCsvInput {
  readonly productPublicId: string;
  readonly reference: string;
  readonly source: AsyncIterable<Uint8Array>;
  readonly validUntil?: Date;
}

export type AdminVoucherBatch = VoucherBatch;

export interface AdminVoucherInventoryOperationsService {
  getBatch(
    actor: AuthenticatedAdmin,
    batchPublicId: string,
  ): Promise<AdminVoucherBatch>;
  importCsv(
    actor: AuthenticatedAdmin,
    input: ImportVoucherCsvInput,
    context: RequestContext,
  ): Promise<AdminVoucherBatch>;
  activateBatch(
    actor: AuthenticatedAdmin,
    batchPublicId: string,
    context: RequestContext,
  ): Promise<{ readonly batch: AdminVoucherBatch; readonly changed: boolean }>;
  discardBatch(
    actor: AuthenticatedAdmin,
    batchPublicId: string,
    context: RequestContext,
  ): Promise<AdminVoucherBatch>;
}

@Injectable()
export class PrismaAdminVoucherInventoryOperationsService
  implements AdminVoucherInventoryOperationsService
{
  private readonly importChunkSize: number;
  private readonly importMaxBytes: number;

  constructor(
    private readonly database: DatabaseClient,
    @Inject(CATALOG_PRODUCT_REFERENCE_QUERY)
    private readonly catalog: CatalogProductReferenceQuery,
    @Inject(VOUCHER_INVENTORY_SERVICE)
    private readonly inventory: VoucherInventoryService,
    config: ConfigService,
  ) {
    this.importChunkSize = config.getOrThrow<number>(
      'VOUCHER_IMPORT_CHUNK_SIZE',
    );
    this.importMaxBytes = config.getOrThrow<number>('VOUCHER_IMPORT_MAX_BYTES');
  }

  async getBatch(
    actor: AuthenticatedAdmin,
    batchPublicId: string,
  ): Promise<AdminVoucherBatch> {
    this.assertInventoryOperator(actor);
    return this.inventory.getBatch(batchPublicId);
  }

  async importCsv(
    actor: AuthenticatedAdmin,
    input: ImportVoucherCsvInput,
    context: RequestContext,
  ): Promise<AdminVoucherBatch> {
    this.assertInventoryOperator(actor);
    const product = await this.catalog.getProductReference(
      input.productPublicId,
    );
    if (product === null) {
      throw new VoucherBatchProductNotFoundError();
    }
    let batch: VoucherBatch | undefined;
    try {
      const startedBatch = await this.inTransaction(async (transaction) => {
        const started = await this.inventory.startImport(transaction, {
          productId: product.id,
          reference: input.reference,
          ...(input.validUntil === undefined
            ? {}
            : { validUntil: input.validUntil }),
        });
        await this.recordAuditEvent(
          transaction,
          actor,
          context,
          'VOUCHER_BATCH_IMPORT_STARTED',
          {
            productPublicId: product.publicId,
            voucherBatchPublicId: started.publicId,
          },
        );
        return started;
      });
      batch = startedBatch;
      for await (const rows of readVoucherImportCsv(
        input.source,
        this.importChunkSize,
        this.importMaxBytes,
      )) {
        await this.inTransaction((transaction) =>
          this.inventory.appendImportChunk(
            transaction,
            startedBatch.id,
            product.id,
            rows,
          ),
        );
      }
      return await this.inTransaction(async (transaction) => {
        const completed = await this.inventory.completeImport(
          transaction,
          startedBatch.id,
        );
        await this.recordAuditEvent(
          transaction,
          actor,
          context,
          'VOUCHER_BATCH_IMPORT_COMPLETED',
          {
            importedQuantity: completed.totalQuantity,
            productPublicId: completed.productPublicId,
            voucherBatchPublicId: completed.publicId,
          },
        );
        return completed;
      });
    } catch (error) {
      if (batch !== undefined) {
        await this.failImportSafely(batch, actor, context, error);
      }
      throw error;
    }
  }

  async activateBatch(
    actor: AuthenticatedAdmin,
    batchPublicId: string,
    context: RequestContext,
  ): Promise<{ readonly batch: AdminVoucherBatch; readonly changed: boolean }> {
    this.assertInventoryOperator(actor);
    return this.inTransaction(async (transaction) => {
      const result = await this.inventory.activateBatch(
        transaction,
        batchPublicId,
      );
      await this.recordAuditEvent(
        transaction,
        actor,
        context,
        'VOUCHER_BATCH_ACTIVATED',
        {
          changed: result.changed,
          productPublicId: result.batch.productPublicId,
          voucherBatchPublicId: result.batch.publicId,
        },
      );
      return result;
    });
  }

  async discardBatch(
    actor: AuthenticatedAdmin,
    batchPublicId: string,
    context: RequestContext,
  ): Promise<AdminVoucherBatch> {
    this.assertInventoryOperator(actor);
    for (;;) {
      const result = await this.inTransaction(async (transaction) => {
        const discarded = await this.inventory.discardBatchChunk(
          transaction,
          batchPublicId,
          this.importChunkSize,
        );
        if (discarded.complete) {
          await this.recordAuditEvent(
            transaction,
            actor,
            context,
            'VOUCHER_BATCH_DISCARDED',
            {
              productPublicId: discarded.batch.productPublicId,
              voucherBatchPublicId: discarded.batch.publicId,
            },
          );
        }
        return discarded;
      });
      if (!result.complete) continue;
      return result.batch;
    }
  }

  private async failImportSafely(
    batch: VoucherBatch,
    actor: AuthenticatedAdmin,
    context: RequestContext,
    cause: unknown,
  ): Promise<void> {
    try {
      await this.inTransaction(async (transaction) => {
        await this.inventory.failImport(transaction, batch.id);
        await this.recordAuditEvent(
          transaction,
          actor,
          context,
          'VOUCHER_BATCH_IMPORT_FAILED',
          {
            failureCategory: safeFailureCategory(cause),
            productPublicId: batch.productPublicId,
            voucherBatchPublicId: batch.publicId,
          },
        );
      });
    } catch {
      // Preserve the original import error. A stale-import sweeper will make
      // the batch non-activatable if the failure transaction itself is lost.
    }
  }

  private async inTransaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 10_000,
      });
    } catch (error) {
      const code = prismaErrorCode(error);
      if (code === 'P2002') {
        throw new VoucherImportConflictError(
          'A voucher import conflicts with existing inventory.',
        );
      }
      if (code === 'P2034') {
        throw new VoucherImportConflictError(
          'Voucher inventory changed concurrently. Retry the operation.',
        );
      }
      throw error;
    }
  }

  private async recordAuditEvent(
    transaction: Prisma.TransactionClient,
    actor: AuthenticatedAdmin,
    context: RequestContext,
    eventType: string,
    metadata: Readonly<Record<string, boolean | number | string>>,
  ): Promise<void> {
    await transaction.adminSecurityEvent.create({
      data: {
        adminUserId: actor.id,
        correlationId: context.correlationId,
        eventType,
        metadata,
      },
    });
  }

  private assertInventoryOperator(actor: AuthenticatedAdmin): void {
    if (actor.role !== 'SUPER_ADMIN' && actor.role !== 'OPERATIONS_ADMIN') {
      throw new AdminAuthorizationError();
    }
  }
}

export class VoucherBatchProductNotFoundError extends Error {
  constructor() {
    super('Catalog product was not found.');
    this.name = 'VoucherBatchProductNotFoundError';
  }
}

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? typeof error.code === 'string'
      ? error.code
      : undefined
    : undefined;
}

function safeFailureCategory(error: unknown): string {
  if (error instanceof VoucherImportConflictError) return 'CONFLICT';
  if (error instanceof VoucherBatchProductNotFoundError)
    return 'PRODUCT_NOT_FOUND';
  if (error instanceof Error && error.name === 'VoucherImportValidationError') {
    return 'INPUT_INVALID';
  }
  return 'UNEXPECTED';
}
