import { Injectable, Module } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { Prisma } from '../../../../../../generated/prisma/client';
import {
  DATABASE_CLIENT,
  DatabaseModule,
  type DatabaseClient,
} from '@edu-api/database';

export const COMMUNICATION_ADMIN_OPERATIONS = Symbol(
  'COMMUNICATION_ADMIN_OPERATIONS',
);

export interface RequestCommunicationRetryInput {
  readonly actorAdminUserId: bigint;
  readonly correlationId: string;
  readonly deliveryPublicId: string;
  readonly idempotencyKey: string;
}

export interface CommunicationAdminOperations {
  requestRetry(input: RequestCommunicationRetryInput): Promise<{
    readonly changed: boolean;
    readonly deliveryPublicId: string;
  }>;
}

export class CommunicationRetryConflictError extends Error {}
export class CommunicationDeliveryNotFoundError extends Error {}

const scope = 'admin-communication-retry';
const idempotencyLifetimeMs = 24 * 60 * 60 * 1_000;

@Injectable()
export class PrismaCommunicationAdminOperations
  implements CommunicationAdminOperations
{
  constructor(private readonly database: DatabaseClient) {}

  async requestRetry(input: RequestCommunicationRetryInput) {
    const fingerprint = createHash('sha256')
      .update(input.deliveryPublicId)
      .digest('base64url');
    try {
      return await this.database.$transaction(
        async (transaction) => {
          const existing = await transaction.idempotencyRecord.findUnique({
            where: { scope_key: { scope, key: input.idempotencyKey } },
          });
          if (existing !== null) {
            if (existing.requestFingerprint !== fingerprint) {
              throw new CommunicationRetryConflictError(
                'The idempotency key was already used for another delivery.',
              );
            }
            if (existing.status === 'COMPLETED') {
              return {
                changed: existing.responseStatus === 200,
                deliveryPublicId:
                  existing.responseReference ?? input.deliveryPublicId,
              };
            }
            throw new CommunicationRetryConflictError(
              'The retry request is already being processed.',
            );
          }

          await transaction.idempotencyRecord.create({
            data: {
              expiresAt: new Date(Date.now() + idempotencyLifetimeMs),
              key: input.idempotencyKey,
              requestFingerprint: fingerprint,
              scope,
            },
          });
          const delivery = await transaction.communicationDelivery.findUnique({
            where: { publicId: input.deliveryPublicId },
            select: { id: true, lastFailureCategory: true, state: true },
          });
          if (delivery === null) {
            throw new CommunicationDeliveryNotFoundError(
              'The communication delivery was not found.',
            );
          }
          if (
            delivery.state !== 'NEEDS_ATTENTION' ||
            delivery.lastFailureCategory === 'UNKNOWN_OUTCOME'
          ) {
            throw new CommunicationRetryConflictError(
              'Only a safe, non-ambiguous needs-attention delivery can be retried.',
            );
          }
          const changed = await transaction.communicationDelivery.updateMany({
            where: {
              id: delivery.id,
              state: 'NEEDS_ATTENTION',
              lastFailureCategory: { not: 'UNKNOWN_OUTCOME' },
            },
            data: {
              lastFailureCategory: null,
              needsAttentionAt: null,
              nextAttemptAt: new Date(),
              state: 'PENDING',
            },
          });
          if (changed.count !== 1) {
            throw new CommunicationRetryConflictError(
              'The delivery changed concurrently. Refresh and retry.',
            );
          }
          await transaction.adminSecurityEvent.create({
            data: {
              adminUserId: input.actorAdminUserId,
              correlationId: input.correlationId,
              eventType: 'COMMUNICATION_DELIVERY_RETRY_REQUESTED',
              metadata: {
                deliveryPublicId: input.deliveryPublicId,
              },
            },
          });
          await transaction.idempotencyRecord.update({
            where: { scope_key: { scope, key: input.idempotencyKey } },
            data: {
              completedAt: new Date(),
              responseReference: input.deliveryPublicId,
              responseStatus: 200,
              status: 'COMPLETED',
            },
          });
          return { changed: true, deliveryPublicId: input.deliveryPublicId };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 10_000,
        },
      );
    } catch (error) {
      if (
        error instanceof CommunicationRetryConflictError ||
        error instanceof CommunicationDeliveryNotFoundError
      ) {
        throw error;
      }
      if (
        prismaErrorCode(error) === 'P2002' ||
        prismaErrorCode(error) === 'P2034'
      ) {
        throw new CommunicationRetryConflictError(
          'The retry request changed concurrently. Retry with the same idempotency key.',
        );
      }
      throw error;
    }
  }
}

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: COMMUNICATION_ADMIN_OPERATIONS,
      inject: [DATABASE_CLIENT],
      useFactory: (database: DatabaseClient) =>
        new PrismaCommunicationAdminOperations(database),
    },
  ],
  exports: [COMMUNICATION_ADMIN_OPERATIONS],
})
export class CommunicationAdminModule {}
