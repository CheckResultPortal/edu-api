import type { DatabaseTransactionClient } from '@edu-api/database';

export const TRANSACTIONAL_VOUCHER_CLAIMER = Symbol(
  'TRANSACTIONAL_VOUCHER_CLAIMER',
);

export interface ClaimEligibleVoucherInput {
  readonly maximumVouchers?: number;
  readonly productId: bigint;
  readonly soldAt: Date;
}

export interface ClaimedVoucherResult {
  readonly productId: bigint;
  readonly voucherId: bigint;
  readonly voucherPublicId: string;
}

export interface TransactionalVoucherClaimer {
  claimEligibleVoucherForProduct(
    transaction: DatabaseTransactionClient,
    input: ClaimEligibleVoucherInput,
  ): Promise<ClaimedVoucherResult | null>;

  claimEligibleVouchersForProduct(
    transaction: DatabaseTransactionClient,
    input: Required<ClaimEligibleVoucherInput>,
  ): Promise<readonly ClaimedVoucherResult[]>;
}
