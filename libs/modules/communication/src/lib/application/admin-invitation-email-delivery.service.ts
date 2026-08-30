import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';

import type { DatabaseClient } from '@edu-api/database';
import type { EmailProvider } from './email-provider';
import {
  AdminInvitationDeliveryReader,
  type AdminInvitationDeliveryConfiguration,
} from './admin-invitation-delivery-reader';

const invitationDeliveryEventType = 'ADMIN_INVITATION_DELIVERY_REQUESTED';
const processingLeaseMs = 60_000;

export interface AdminInvitationDeliveryWorkerOptions {
  readonly from: string;
  readonly providerName: string;
  readonly maximumAutomaticAttempts: number;
  readonly workerId: string;
}

@Injectable()
export class AdminInvitationEmailDeliveryService {
  private readonly invitations: AdminInvitationDeliveryReader;

  constructor(
    private readonly database: DatabaseClient,
    configuration: AdminInvitationDeliveryConfiguration,
    private readonly provider: EmailProvider,
    private readonly options: AdminInvitationDeliveryWorkerOptions,
  ) {
    this.invitations = new AdminInvitationDeliveryReader(
      database,
      configuration,
    );
  }

  /** Claims a bounded number of outbox events with SKIP LOCKED. */
  async processAvailable(limit = 25): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const events = await this.claimOutboxEvents(boundedLimit);
    for (const event of events) {
      await this.processEvent(event.id, event.payload);
    }
    return events.length;
  }

  async recoverStalledDeliveries(limit = 25): Promise<number> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - processingLeaseMs);
    const stale = await this.database.adminInvitationEmailDelivery.findMany({
      where: { state: 'PROCESSING', processingStartedAt: { lt: staleBefore } },
      select: {
        id: true,
        attempts: {
          where: { outcome: 'PROCESSING' },
          select: { id: true, startedAt: true },
          orderBy: { attemptNumber: 'desc' },
          take: 1,
        },
      },
      orderBy: { id: 'asc' },
      take: Math.max(1, Math.min(limit, 100)),
    });
    if (stale.length === 0) return 0;
    let recovered = 0;
    for (const delivery of stale) {
      const attempt = delivery.attempts[0];
      const idempotencyWindowExpired =
        attempt === undefined ||
        now.getTime() - attempt.startedAt.getTime() >=
          this.provider.idempotencyRetentionMs;
      const changed = await this.database.$transaction(async (transaction) => {
        if (idempotencyWindowExpired) {
          if (attempt !== undefined) {
            await transaction.adminInvitationEmailAttempt.updateMany({
              where: { id: attempt.id, outcome: 'PROCESSING' },
              data: { outcome: 'UNKNOWN_OUTCOME', completedAt: now },
            });
          }
          return transaction.adminInvitationEmailDelivery.updateMany({
            where: { id: delivery.id, state: 'PROCESSING' },
            data: {
              state: 'NEEDS_ATTENTION',
              processingStartedAt: null,
              lastFailureCategory: 'UNKNOWN_OUTCOME',
              needsAttentionAt: now,
            },
          });
        }
        return transaction.adminInvitationEmailDelivery.updateMany({
          where: { id: delivery.id, state: 'PROCESSING' },
          data: {
            state: 'RETRYING',
            processingStartedAt: null,
            nextAttemptAt: now,
          },
        });
      });
      recovered += changed.count;
    }
    return recovered;
  }

  private async claimOutboxEvents(
    limit: number,
  ): Promise<readonly { id: bigint; payload: unknown }[]> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - processingLeaseMs);
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<
        readonly { id: bigint; payload: unknown }[]
      >`
        SELECT "id", "payload"
        FROM "OutboxEvent"
        WHERE "eventType" = ${invitationDeliveryEventType}
          AND "publishedAt" IS NULL
          AND "needsAttentionAt" IS NULL
          AND "availableAt" <= ${now}
          AND ("lockedAt" IS NULL OR "lockedAt" < ${staleBefore})
        ORDER BY "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      `;
      if (rows.length === 0) return rows;
      await transaction.outboxEvent.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: {
          attempts: { increment: 1 },
          lockedAt: now,
          lockOwner: this.options.workerId,
        },
      });
      return rows;
    });
  }

  private async processEvent(eventId: bigint, payload: unknown): Promise<void> {
    const invitationPublicId = invitationReference(payload);
    if (invitationPublicId === null) {
      await this.markOutboxNeedsAttention(eventId, 'INVALID_EVENT_PAYLOAD');
      return;
    }
    const invitation =
      await this.invitations.getPendingInvitation(invitationPublicId);
    if (invitation === null) {
      await this.markOutboxPublished(eventId);
      return;
    }
    const delivery = await this.getOrCreateDelivery(invitation);
    if (delivery.state === 'SENT' || delivery.state === 'NEEDS_ATTENTION') {
      await this.markOutboxPublished(eventId);
      return;
    }
    if (delivery.nextAttemptAt > new Date()) {
      await this.releaseOutbox(eventId, delivery.nextAttemptAt);
      return;
    }
    await this.deliver(eventId, delivery, invitation);
  }

  private async getOrCreateDelivery(invitation: {
    readonly email: string;
    readonly invitationId: bigint;
    readonly invitationPublicId: string;
    readonly invitationUrl: string;
  }) {
    return this.database.adminInvitationEmailDelivery.upsert({
      where: { invitationId: invitation.invitationId },
      create: {
        invitationId: invitation.invitationId,
        destinationEmail: invitation.email,
      },
      update: {},
    });
  }

  private async deliver(
    eventId: bigint,
    delivery: {
      readonly id: bigint;
      readonly attemptCount: number;
      readonly publicId: string;
    },
    invitation: {
      readonly email: string;
      readonly invitationId: bigint;
      readonly invitationPublicId: string;
      readonly invitationUrl: string;
    },
  ): Promise<void> {
    const now = new Date();
    const claimed = await this.database.$transaction(async (transaction) => {
      const existingAttempt =
        await transaction.adminInvitationEmailAttempt.findFirst({
          where: { deliveryId: delivery.id, outcome: 'PROCESSING' },
          select: { id: true, attemptNumber: true },
          orderBy: { attemptNumber: 'desc' },
        });
      if (existingAttempt !== null) {
        const resumed =
          await transaction.adminInvitationEmailDelivery.updateMany({
            where: {
              id: delivery.id,
              state: 'RETRYING',
              nextAttemptAt: { lte: now },
            },
            data: { state: 'PROCESSING', processingStartedAt: now },
          });
        return resumed.count === 1 ? existingAttempt : null;
      }
      const changed = await transaction.adminInvitationEmailDelivery.updateMany(
        {
          where: {
            id: delivery.id,
            state: { in: ['PENDING', 'RETRYING'] },
            nextAttemptAt: { lte: now },
          },
          data: {
            state: 'PROCESSING',
            processingStartedAt: now,
            attemptCount: { increment: 1 },
          },
        },
      );
      if (changed.count !== 1) return null;
      const current =
        await transaction.adminInvitationEmailDelivery.findUniqueOrThrow({
          where: { id: delivery.id },
          select: { attemptCount: true },
        });
      const attempt = await transaction.adminInvitationEmailAttempt.create({
        data: {
          deliveryId: delivery.id,
          attemptNumber: current.attemptCount,
          provider: this.options.providerName,
        },
        select: { id: true, attemptNumber: true },
      });
      return attempt;
    });
    if (claimed === null) return;

    let result: Awaited<ReturnType<EmailProvider['send']>>;
    try {
      result = await this.provider.send({
        from: this.options.from,
        to: invitation.email,
        subject: 'You are invited to administer EduVoucher',
        text: `Accept your administrator invitation: ${invitation.invitationUrl}`,
        html: `<p>You have been invited to administer EduVoucher.</p><p><a href="${escapeHtml(invitation.invitationUrl)}">Accept invitation</a></p>`,
        idempotencyKey: `admin-invitation-email:${delivery.publicId}:${claimed.attemptNumber}`,
      });
    } catch {
      result = { status: 'FAILED', category: 'UNKNOWN_OUTCOME' };
    }
    await this.finishDelivery(
      eventId,
      delivery.id,
      claimed.id,
      claimed.attemptNumber,
      result,
    );
  }

  private async finishDelivery(
    eventId: bigint,
    deliveryId: bigint,
    attemptId: bigint,
    attemptNumber: number,
    result: Awaited<ReturnType<EmailProvider['send']>>,
  ): Promise<void> {
    const now = new Date();
    await this.database.$transaction(async (transaction) => {
      if (result.status === 'SENT') {
        await transaction.adminInvitationEmailAttempt.update({
          where: { id: attemptId },
          data: {
            outcome: 'SENT',
            providerMessageId: result.providerMessageId,
            completedAt: now,
          },
        });
        await transaction.adminInvitationEmailDelivery.update({
          where: { id: deliveryId },
          data: {
            state: 'SENT',
            providerMessageId: result.providerMessageId,
            processingStartedAt: null,
          },
        });
        await this.publishOutboxInTransaction(transaction, eventId, now);
        return;
      }

      await transaction.adminInvitationEmailAttempt.update({
        where: { id: attemptId },
        data: {
          outcome: result.category,
          ...(result.providerCode === undefined
            ? {}
            : { providerCode: result.providerCode }),
          completedAt: now,
        },
      });
      const retryAt = retryAtFor(
        result.category,
        attemptNumber,
        this.options.maximumAutomaticAttempts,
        now,
      );
      const needsAttention = retryAt === null;
      await transaction.adminInvitationEmailDelivery.update({
        where: { id: deliveryId },
        data: {
          state: needsAttention ? 'NEEDS_ATTENTION' : 'RETRYING',
          processingStartedAt: null,
          lastFailureCategory: result.category,
          ...(needsAttention
            ? { needsAttentionAt: now }
            : { nextAttemptAt: retryAt }),
        },
      });
      if (needsAttention) {
        await transaction.outboxEvent.updateMany({
          where: { id: eventId, lockOwner: this.options.workerId },
          data: { lockOwner: null, lockedAt: null, needsAttentionAt: now },
        });
      } else {
        await transaction.outboxEvent.updateMany({
          where: { id: eventId, lockOwner: this.options.workerId },
          data: { lockOwner: null, lockedAt: null, availableAt: retryAt },
        });
      }
    });
  }

  private async markOutboxPublished(eventId: bigint): Promise<void> {
    const now = new Date();
    await this.database.outboxEvent.updateMany({
      where: { id: eventId, lockOwner: this.options.workerId },
      data: { publishedAt: now, lockedAt: null, lockOwner: null },
    });
  }

  private async markOutboxNeedsAttention(
    eventId: bigint,
    code: string,
  ): Promise<void> {
    const now = new Date();
    await this.database.outboxEvent.updateMany({
      where: { id: eventId, lockOwner: this.options.workerId },
      data: {
        lockedAt: null,
        lockOwner: null,
        lastFailureCode: code,
        needsAttentionAt: now,
      },
    });
  }

  private async releaseOutbox(
    eventId: bigint,
    availableAt: Date,
  ): Promise<void> {
    await this.database.outboxEvent.updateMany({
      where: { id: eventId, lockOwner: this.options.workerId },
      data: { lockedAt: null, lockOwner: null, availableAt },
    });
  }

  private async publishOutboxInTransaction(
    transaction: Pick<DatabaseClient, 'outboxEvent'>,
    eventId: bigint,
    now: Date,
  ): Promise<void> {
    await transaction.outboxEvent.updateMany({
      where: { id: eventId, lockOwner: this.options.workerId },
      data: { publishedAt: now, lockedAt: null, lockOwner: null },
    });
  }
}

function invitationReference(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const reference = (payload as Record<string, unknown>).invitationPublicId;
  return typeof reference === 'string' ? reference : null;
}

function retryAtFor(
  category: string,
  attemptNumber: number,
  maximumAutomaticAttempts: number,
  now: Date,
): Date | null {
  if (
    category === 'UNKNOWN_OUTCOME' ||
    category === 'AUTHENTICATION' ||
    category === 'INVALID_REQUEST' ||
    category === 'PERMANENT' ||
    attemptNumber >= maximumAutomaticAttempts
  ) {
    return null;
  }
  const maximumDelayMs = 15 * 60 * 1000;
  const exponentialDelayMs = Math.min(
    maximumDelayMs,
    30_000 * 2 ** Math.max(0, attemptNumber - 1),
  );
  const jitterMs = randomInt(0, Math.min(30_000, exponentialDelayMs / 4) + 1);
  return new Date(now.getTime() + exponentialDelayMs + jitterMs);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[character] as string;
  });
}
