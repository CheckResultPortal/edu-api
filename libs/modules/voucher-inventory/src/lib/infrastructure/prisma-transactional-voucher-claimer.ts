import type { DatabaseTransactionClient } from '@edu-api/database';

import type {
  ClaimEligibleVoucherInput,
  ClaimedVoucherResult,
  TransactionalVoucherClaimer,
} from '../application/transactional-voucher-claimer';

export class PrismaTransactionalVoucherClaimer
  implements TransactionalVoucherClaimer
{
  async claimEligibleVoucherForProduct(
    transaction: DatabaseTransactionClient,
    input: ClaimEligibleVoucherInput,
  ): Promise<ClaimedVoucherResult | null> {
    // Claim only the selected voucher row; locked vouchers are already being
    // handled by another allocation worker.
    const vouchers = await transaction.$queryRaw<
      Array<{
        id: bigint;
        productId: bigint;
        publicId: string;
      }>
    >`
      SELECT
        voucher.id,
        voucher."productId",
        voucher."publicId"::text AS "publicId"
      FROM "Voucher" AS voucher
      JOIN "VoucherBatch" AS voucher_batch
        ON voucher_batch.id = voucher."batchId"
        AND voucher_batch."productId" = voucher."productId"
      WHERE voucher."productId" = ${input.productId}
        AND voucher.status = 'AVAILABLE'::"VoucherStatus"
        AND voucher_batch."importState" = 'IMPORTED'::"VoucherBatchImportState"
        AND voucher_batch."activatedAt" IS NOT NULL
        AND (
          voucher_batch."validUntil" IS NULL
          OR voucher_batch."validUntil" > ${input.soldAt}
        )
      ORDER BY voucher_batch.id ASC, voucher.id ASC
      LIMIT 1
      FOR UPDATE OF voucher SKIP LOCKED
    `;

    const voucher = vouchers[0];
    if (!voucher) {
      return null;
    }

    const soldVoucherCount = await transaction.$executeRaw`
      UPDATE "Voucher"
      SET status = 'SOLD'::"VoucherStatus",
          "soldAt" = ${input.soldAt},
          "updatedAt" = ${input.soldAt}
      WHERE id = ${voucher.id}
        AND "productId" = ${input.productId}
        AND status = 'AVAILABLE'::"VoucherStatus"
    `;
    if (soldVoucherCount !== 1) {
      throw new Error('The claimed voucher was not available for sale.');
    }

    return {
      productId: voucher.productId,
      voucherId: voucher.id,
      voucherPublicId: voucher.publicId,
    };
  }
}
