import { Prisma } from '../../../../../../generated/prisma/client';

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
    const vouchers = await this.claimEligibleVouchersForProduct(transaction, {
      maximumVouchers: 1,
      productId: input.productId,
      soldAt: input.soldAt,
    });
    return vouchers[0] ?? null;
  }

  async claimEligibleVouchersForProduct(
    transaction: DatabaseTransactionClient,
    input: Required<ClaimEligibleVoucherInput>,
  ): Promise<readonly ClaimedVoucherResult[]> {
    if (
      !Number.isInteger(input.maximumVouchers) ||
      input.maximumVouchers < 1 ||
      input.maximumVouchers > 500
    ) {
      throw new Error('maximumVouchers must be an integer between 1 and 500.');
    }

    // Claim the selected voucher rows together; rows locked by another worker
    // remain available for that worker's short allocation transaction.
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
      LIMIT ${input.maximumVouchers}
      FOR UPDATE OF voucher SKIP LOCKED
    `;

    if (vouchers.length === 0) return [];

    const soldVoucherCount = await transaction.$executeRaw`
      UPDATE "Voucher"
      SET status = 'SOLD'::"VoucherStatus",
          "soldAt" = ${input.soldAt},
          "updatedAt" = ${input.soldAt}
      WHERE id IN (${Prisma.join(vouchers.map((voucher) => voucher.id))})
        AND "productId" = ${input.productId}
        AND status = 'AVAILABLE'::"VoucherStatus"
    `;
    if (soldVoucherCount !== vouchers.length) {
      throw new Error('A claimed voucher was not available for sale.');
    }

    return vouchers.map((voucher) => ({
      productId: voucher.productId,
      voucherId: voucher.id,
      voucherPublicId: voucher.publicId,
    }));
  }
}
