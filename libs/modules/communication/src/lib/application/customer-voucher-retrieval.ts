import { Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';

import { Prisma } from '../../../../../../generated/prisma/client';
import {
  DATABASE_CLIENT,
  DatabaseModule,
  type DatabaseClient,
} from '@edu-api/database';

export const CUSTOMER_VOUCHER_RETRIEVAL = Symbol(
  'CUSTOMER_VOUCHER_RETRIEVAL',
);

export interface CustomerVoucherRetrieval {
  request(input: {
    readonly destinationEmail: string;
    readonly idempotencyKey: string;
    readonly orderId: bigint;
  }): Promise<{ readonly deliveryPublicId: string }>;
}

export class CustomerVoucherRetrievalConflictError extends Error {}

const scope = 'customer-voucher-retrieval';
const idempotencyLifetimeMs = 24 * 60 * 60 * 1_000;

@Injectable()
export class PrismaCustomerVoucherRetrieval
  implements CustomerVoucherRetrieval
{
  constructor(
    private readonly database: DatabaseClient,
    private readonly privacyHmacKey: Uint8Array,
  ) {}

  async request(input: {
    readonly destinationEmail: string;
    readonly idempotencyKey: string;
    readonly orderId: bigint;
  }): Promise<{ readonly deliveryPublicId: string }> {
    const fingerprint = createHmac('sha256', this.privacyHmacKey)
      .update('customer-voucher-retrieval:v1:', 'utf8')
      .update(input.orderId.toString(), 'utf8')
      .update(':', 'utf8')
      .update(input.destinationEmail, 'utf8')
      .digest('base64url');
    try {
      return await this.database.$transaction(
        async (transaction) => {
          const now = new Date();
          await transaction.idempotencyRecord.deleteMany({
            where: {
              scope,
              key: input.idempotencyKey,
              expiresAt: { lte: now },
            },
          });
          const existing = await transaction.idempotencyRecord.findUnique({
            where: { scope_key: { scope, key: input.idempotencyKey } },
          });
          if (existing !== null) {
            if (existing.requestFingerprint !== fingerprint) {
              throw new CustomerVoucherRetrievalConflictError(
                'The request key was already used for a different retrieval.',
              );
            }
            if (
              existing.status === 'COMPLETED' &&
              existing.responseReference !== null
            ) {
              return { deliveryPublicId: existing.responseReference };
            }
            throw new CustomerVoucherRetrievalConflictError(
              'The retrieval request is already being processed.',
            );
          }

          await transaction.idempotencyRecord.create({
            data: {
              expiresAt: new Date(now.getTime() + idempotencyLifetimeMs),
              key: input.idempotencyKey,
              requestFingerprint: fingerprint,
              scope,
            },
          });
          const delivery = await transaction.voucherRetrievalEmailDelivery.create({
            data: {
              destinationEmail: input.destinationEmail,
              orderId: input.orderId,
            },
            select: { publicId: true },
          });
          await transaction.idempotencyRecord.update({
            where: { scope_key: { scope, key: input.idempotencyKey } },
            data: {
              completedAt: now,
              responseReference: delivery.publicId,
              responseStatus: 202,
              status: 'COMPLETED',
            },
          });
          return { deliveryPublicId: delivery.publicId };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 10_000,
        },
      );
    } catch (error) {
      if (error instanceof CustomerVoucherRetrievalConflictError) throw error;
      if (prismaErrorCode(error) === 'P2002' || prismaErrorCode(error) === 'P2034') {
        throw new CustomerVoucherRetrievalConflictError(
          'The retrieval request changed concurrently. Retry with the same request key.',
        );
      }
      throw error;
    }
  }
}

@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: CUSTOMER_VOUCHER_RETRIEVAL,
      inject: [DATABASE_CLIENT, ConfigService],
      useFactory: (database: DatabaseClient, config: ConfigService) =>
        new PrismaCustomerVoucherRetrieval(
          database,
          decodePrivacyHmacKey(
            config.getOrThrow<string>('ORDER_PRIVACY_HMAC_KEY'),
          ),
        ),
    },
  ],
  exports: [CUSTOMER_VOUCHER_RETRIEVAL],
})
export class CustomerVoucherRetrievalModule {}

function decodePrivacyHmacKey(value: string): Uint8Array {
  const key = Buffer.from(value, 'base64url');
  if (key.byteLength !== 32) {
    throw new Error('ORDER_PRIVACY_HMAC_KEY must contain 32 bytes.');
  }
  return key;
}

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
