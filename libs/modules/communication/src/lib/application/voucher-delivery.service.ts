import { randomInt } from 'node:crypto';

import {
  decryptSecret,
  type EncryptedSecret,
  type SecretKeyring,
} from '@edu-api/encryption';
import type { DatabaseClient } from '@edu-api/database';

import type { EmailProvider } from './email-provider';
import type { SmsProvider } from './sms-provider';
import { generateVoucherDeliveryArtifacts } from './voucher-delivery-artifacts';

export interface VoucherDeliveryWorkerOptions {
  readonly emailFrom: string;
  readonly maximumAutomaticAttempts: number;
  readonly maximumRetryDelayMs: number;
  readonly processingLeaseMs: number;
  readonly retryBaseDelayMs: number;
  readonly supportPhone: string;
}

interface ClaimedDelivery {
  readonly attemptId: bigint;
  readonly attemptNumber: number;
  readonly channel: 'SMS' | 'EMAIL';
  readonly deliveryId: bigint;
  readonly deliveryPublicId: string;
  readonly destination: string;
  readonly encryptedPin: unknown;
  readonly leaseUntil: Date;
  readonly orderPublicReference: string;
  readonly productName: string;
  readonly resultCheckerUrl?: string;
  readonly serialNumber: string;
}

export class VoucherDeliveryService {
  constructor(
    private readonly database: DatabaseClient,
    private readonly emailProvider: EmailProvider,
    private readonly smsProvider: SmsProvider,
    private readonly keyring: SecretKeyring,
    private readonly options: VoucherDeliveryWorkerOptions,
    private readonly logger?: {
      error(message: string, trace?: string, context?: string): void;
    },
  ) {}

  async processAvailable(limit: number): Promise<number> {
    const due = await this.database.communicationDelivery.findMany({
      where: {
        state: { in: ['PENDING', 'RETRYING'] },
        nextAttemptAt: { lte: new Date() },
      },
      select: { id: true },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: bounded(limit),
    });
    let processed = 0;
    for (const candidate of due) {
      const claimed = await this.claim(candidate.id);
      if (claimed === null) continue;
      processed += 1;
      await this.send(claimed);
    }
    return processed;
  }

  async recoverStalledDeliveries(limit: number): Promise<number> {
    const now = new Date();
    const stale = await this.database.communicationDelivery.findMany({
      where: { state: 'PROCESSING', processingLeaseUntil: { lt: now } },
      select: {
        id: true,
        publicId: true,
        channel: true,
        processingLeaseUntil: true,
        attempts: {
          where: { outcome: 'PROCESSING' },
          orderBy: { attemptNumber: 'desc' },
          take: 1,
          select: { id: true, attemptNumber: true },
        },
      },
      orderBy: { processingLeaseUntil: 'asc' },
      take: bounded(limit),
    });
    let recovered = 0;
    for (const delivery of stale) {
      const attempt = delivery.attempts[0];
      if (attempt === undefined || delivery.processingLeaseUntil === null)
        continue;
      const recoveryLeaseUntil = new Date(
        now.getTime() + this.options.processingLeaseMs,
      );
      const claimed = await this.database.communicationDelivery.updateMany({
        where: {
          id: delivery.id,
          state: 'PROCESSING',
          processingLeaseUntil: delivery.processingLeaseUntil,
        },
        data: { processingLeaseUntil: recoveryLeaseUntil },
      });
      if (claimed.count !== 1) continue;
      recovered += 1;
      const reference = referenceFor(delivery.publicId);
      const lookup =
        delivery.channel === 'SMS'
          ? await this.smsProvider.lookup(reference)
          : 'UNKNOWN';
      if (lookup === 'ACCEPTED') {
        await this.finish(
          delivery.id,
          attempt.id,
          recoveryLeaseUntil,
          { status: 'SENT', providerMessageId: reference },
          attempt.attemptNumber,
        );
      } else if (lookup === 'NOT_FOUND') {
        await this.finish(
          delivery.id,
          attempt.id,
          recoveryLeaseUntil,
          { status: 'FAILED', category: 'TEMPORARY' },
          attempt.attemptNumber,
        );
      } else {
        await this.finish(
          delivery.id,
          attempt.id,
          recoveryLeaseUntil,
          { status: 'FAILED', category: 'UNKNOWN_OUTCOME' },
          attempt.attemptNumber,
        );
      }
    }
    return recovered;
  }

  private async claim(deliveryId: bigint): Promise<ClaimedDelivery | null> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.options.processingLeaseMs);
    return this.database.$transaction(async (transaction) => {
      const changed = await transaction.communicationDelivery.updateMany({
        where: {
          id: deliveryId,
          state: { in: ['PENDING', 'RETRYING'] },
          nextAttemptAt: { lte: now },
        },
        data: {
          attemptCount: { increment: 1 },
          processingLeaseUntil: leaseUntil,
          state: 'PROCESSING',
        },
      });
      if (changed.count !== 1) return null;
      const delivery =
        await transaction.communicationDelivery.findUniqueOrThrow({
          where: { id: deliveryId },
          select: {
            id: true,
            publicId: true,
            channel: true,
            destination: true,
            attemptCount: true,
            communication: {
              select: {
                allocation: {
                  select: {
                    fulfilmentUnit: {
                      select: {
                        orderPublicReference: true,
                        orderItem: {
                          select: { order: { select: { customerCode: true } } },
                        },
                      },
                    },
                    product: {
                      select: { name: true, resultCheckerUrl: true },
                    },
                    voucher: {
                      select: { encryptedPin: true, serialNumber: true },
                    },
                  },
                },
              },
            },
          },
        });
      const attempt = await transaction.communicationAttempt.create({
        data: {
          attemptNumber: delivery.attemptCount,
          deliveryId,
          provider:
            delivery.channel === 'SMS' ? this.smsProvider.name : 'resend',
        },
        select: { id: true },
      });
      return {
        attemptId: attempt.id,
        attemptNumber: delivery.attemptCount,
        channel: delivery.channel,
        deliveryId,
        deliveryPublicId: delivery.publicId,
        destination: delivery.destination,
        encryptedPin: delivery.communication.allocation.voucher.encryptedPin,
        leaseUntil,
        orderPublicReference: delivery.communication.allocation.fulfilmentUnit
          .orderItem?.order.customerCode
          ? `EDUPAY-${delivery.communication.allocation.fulfilmentUnit.orderItem.order.customerCode}`
          : delivery.communication.allocation.fulfilmentUnit
              .orderPublicReference,
        productName: delivery.communication.allocation.product.name,
        ...(delivery.communication.allocation.product.resultCheckerUrl === null
          ? {}
          : {
              resultCheckerUrl:
                delivery.communication.allocation.product.resultCheckerUrl,
            }),
        serialNumber: delivery.communication.allocation.voucher.serialNumber,
      };
    });
  }

  private async send(claimed: ClaimedDelivery): Promise<void> {
    let result:
      | { readonly providerMessageId: string; readonly status: 'SENT' }
      | {
          readonly category:
            | 'AUTHENTICATION'
            | 'INVALID_REQUEST'
            | 'PERMANENT'
            | 'RATE_LIMITED'
            | 'TEMPORARY'
            | 'UNKNOWN_OUTCOME';
          readonly providerCode?: string;
          readonly status: 'FAILED';
        };
    try {
      if (!isEncryptedSecret(claimed.encryptedPin))
        throw new Error('Invalid encrypted voucher PIN.');
      const pin = decryptSecret(claimed.encryptedPin, this.keyring);
      const text = `EduVoucher\nOrder: ${claimed.orderPublicReference}\n${claimed.productName}\nSerial: ${claimed.serialNumber}\nPIN: ${pin}\nKeep your voucher private.`;
      const reference = referenceFor(claimed.deliveryPublicId);
      const support = `For support, call ${this.options.supportPhone}.`;
      result =
        claimed.channel === 'SMS'
          ? await this.smsProvider.send({
              message: text,
              reference,
              to: claimed.destination,
            })
          : await this.emailProvider.send({
              attachments: await generateVoucherDeliveryArtifacts({
                deliveryPublicId: claimed.deliveryPublicId,
                orderPublicReference: claimed.orderPublicReference,
                pin,
                productName: claimed.productName,
                ...(claimed.resultCheckerUrl === undefined
                  ? {}
                  : { resultCheckerUrl: claimed.resultCheckerUrl }),
                serialNumber: claimed.serialNumber,
                supportPhone: this.options.supportPhone,
              }),
              from: this.options.emailFrom,
              to: claimed.destination,
              subject: 'Your EduVoucher result checker voucher',
              text: `${text}\n\n${support}`,
              html: renderVoucherDeliveryEmailHtml({
                orderPublicReference: claimed.orderPublicReference,
                pin,
                productName: claimed.productName,
                ...(claimed.resultCheckerUrl === undefined
                  ? {}
                  : { resultCheckerUrl: claimed.resultCheckerUrl }),
                serialNumber: claimed.serialNumber,
                supportPhone: this.options.supportPhone,
              }),
              idempotencyKey: reference,
            });
    } catch (error) {
      this.logger?.error(
        `Delivery ${claimed.deliveryPublicId} failed during preparation/send: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
        'VoucherDeliveryService',
      );
      result = { category: 'PERMANENT', status: 'FAILED' };
    }
    await this.finish(
      claimed.deliveryId,
      claimed.attemptId,
      claimed.leaseUntil,
      result,
      claimed.attemptNumber,
    );
  }

  private async finish(
    deliveryId: bigint,
    attemptId: bigint,
    leaseUntil: Date,
    result:
      | { readonly providerMessageId: string; readonly status: 'SENT' }
      | {
          readonly category:
            | 'AUTHENTICATION'
            | 'INVALID_REQUEST'
            | 'PERMANENT'
            | 'RATE_LIMITED'
            | 'TEMPORARY'
            | 'UNKNOWN_OUTCOME';
          readonly providerCode?: string;
          readonly status: 'FAILED';
        },
    attemptNumber?: number,
  ): Promise<void> {
    const now = new Date();
    await this.database.$transaction(async (transaction) => {
      const active = await transaction.communicationDelivery.updateMany({
        where: {
          id: deliveryId,
          processingLeaseUntil: leaseUntil,
          state: 'PROCESSING',
        },
        data:
          result.status === 'SENT'
            ? {
                processingLeaseUntil: null,
                providerMessageId: result.providerMessageId,
                sentAt: now,
                state: 'SENT',
              }
            : failureUpdate(
                result.category,
                attemptNumber ?? 1,
                this.options,
                now,
              ),
      });
      if (active.count !== 1) return;
      await transaction.communicationAttempt.updateMany({
        where: { id: attemptId, outcome: 'PROCESSING' },
        data:
          result.status === 'SENT'
            ? {
                completedAt: now,
                outcome: 'SENT',
                providerMessageId: result.providerMessageId,
              }
            : {
                completedAt: now,
                outcome: result.category,
                ...(result.providerCode === undefined
                  ? {}
                  : { providerCode: result.providerCode }),
              },
      });
    });
  }
}

function failureUpdate(
  category:
    | 'AUTHENTICATION'
    | 'INVALID_REQUEST'
    | 'PERMANENT'
    | 'RATE_LIMITED'
    | 'TEMPORARY'
    | 'UNKNOWN_OUTCOME',
  attempt: number,
  options: VoucherDeliveryWorkerOptions,
  now: Date,
) {
  if (category === 'UNKNOWN_OUTCOME')
    return {
      lastFailureCategory: category,
      needsAttentionAt: now,
      processingLeaseUntil: null,
      state: 'UNKNOWN' as const,
    };
  if (
    !['TEMPORARY', 'RATE_LIMITED'].includes(category) ||
    attempt >= options.maximumAutomaticAttempts
  )
    return {
      lastFailureCategory: category,
      needsAttentionAt: now,
      processingLeaseUntil: null,
      state: 'NEEDS_ATTENTION' as const,
    };
  const delay = Math.min(
    options.maximumRetryDelayMs,
    options.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  return {
    lastFailureCategory: category,
    nextAttemptAt: new Date(
      now.getTime() + delay + randomInt(0, Math.max(1, Math.floor(delay / 4))),
    ),
    processingLeaseUntil: null,
    state: 'RETRYING' as const,
  };
}
function referenceFor(deliveryPublicId: string): string {
  return `eduvoucher-${deliveryPublicId}`;
}
function bounded(value: number): number {
  return Math.max(1, Math.min(value, 100));
}
function isEncryptedSecret(value: unknown): value is EncryptedSecret {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).algorithm === 'aes-256-gcm' &&
    typeof (value as Record<string, unknown>).ciphertext === 'string' &&
    typeof (value as Record<string, unknown>).iv === 'string' &&
    typeof (value as Record<string, unknown>).authTag === 'string' &&
    typeof (value as Record<string, unknown>).keyId === 'string'
  );
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ] as string,
  );
}

interface VoucherDeliveryEmailHtmlInput {
  readonly orderPublicReference: string;
  readonly pin: string;
  readonly productName: string;
  readonly resultCheckerUrl?: string;
  readonly serialNumber: string;
  readonly supportPhone: string;
}

function renderVoucherDeliveryEmailHtml(
  input: VoucherDeliveryEmailHtmlInput,
): string {
  const resultCheckerButton = input.resultCheckerUrl
    ? `
    <table width="100%" border="0" cellspacing="0" cellpadding="0" style="margin: 0 0 24px 0;">
      <tr>
        <td align="center">
          <table border="0" cellspacing="0" cellpadding="0">
            <tr>
              <td align="center" style="border-radius: 8px; background-color: #23674d;">
                <a href="${escapeHtml(input.resultCheckerUrl)}" target="_blank" rel="noopener noreferrer" style="display: inline-block; padding: 13px 28px; font-size: 14px; font-weight: 700; color: #ffffff; text-decoration: none; border-radius: 8px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                  Open Official Result Checker Portal &rarr;
                </a>
              </td>
            </tr>
          </table>
          <div style="margin-top: 8px; font-size: 12px; color: #64748b;">
            Direct link: <a href="${escapeHtml(input.resultCheckerUrl)}" target="_blank" rel="noopener noreferrer" style="color: #23674d; text-decoration: underline;">${escapeHtml(input.resultCheckerUrl)}</a>
          </div>
        </td>
      </tr>
    </table>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your EduVoucher Result Checker Voucher</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f8fafc; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 580px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.07), 0 2px 4px -2px rgba(0, 0, 0, 0.05); border: 1px solid #e2e8f0;">
          <tr>
            <td style="background-color: #0c3529; padding: 28px 32px; text-align: center; border-bottom: 3px solid #ddb954;">
              <div style="font-size: 22px; font-weight: 800; letter-spacing: 2px; color: #ffffff; text-transform: uppercase;">EDUVOUCHER</div>
              <div style="font-size: 13px; color: #a6d7c0; margin-top: 4px; font-weight: 500;">Official Result Checker Delivery</div>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px 32px 24px 32px;">
              <h1 style="margin: 0 0 8px 0; font-size: 20px; font-weight: 700; color: #0c3529; line-height: 1.3;">Your Voucher is Ready</h1>
              <p style="margin: 0 0 20px 0; font-size: 14px; color: #64748b; line-height: 1.5;">Thank you for your purchase. Your result-checker voucher details are below.</p>
              <table width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-bottom: 24px;">
                <tr>
                  <td style="background-color: #ebf7f1; border: 1px solid #d0ebdd; border-radius: 8px; padding: 12px 16px;">
                    <table width="100%" border="0" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="font-size: 13px; color: #479e79;">Product:</td>
                        <td align="right" style="font-size: 14px; font-weight: 600; color: #0c3529;">${escapeHtml(input.productName)}</td>
                      </tr>
                      <tr>
                        <td style="font-size: 13px; color: #479e79; padding-top: 6px;">Order Ref:</td>
                        <td align="right" style="font-size: 13px; font-family: monospace; font-weight: 600; color: #19533e; padding-top: 6px;">${escapeHtml(input.orderPublicReference)}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #ffffff; border: 2px solid #23674d; border-radius: 10px; overflow: hidden; margin-bottom: 24px;">
                <tr>
                  <td style="background-color: #ebf7f1; padding: 10px 16px; border-bottom: 1px solid #d0ebdd;">
                    <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #19533e;">Voucher Credentials</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 20px 20px 16px 20px;">
                    <div style="font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Serial Number</div>
                    <div style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace; font-size: 17px; font-weight: 700; color: #0c3529; letter-spacing: 1px; margin-bottom: 16px; word-break: break-all;">${escapeHtml(input.serialNumber)}</div>
                    <div style="height: 1px; background-color: #e2e8f0; margin-bottom: 16px;"></div>
                    <div style="font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">Voucher PIN</div>
                    <div style="background-color: #ebf7f1; border: 1.5px dashed #23674d; border-radius: 8px; padding: 12px 16px; text-align: center;">
                      <span style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace; font-size: 24px; font-weight: 800; color: #0c3529; letter-spacing: 2px; word-break: break-all;">${escapeHtml(input.pin)}</span>
                    </div>
                  </td>
                </tr>
              </table>
              ${resultCheckerButton}
              <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f8fafc; border-radius: 8px; padding: 16px; margin-bottom: 20px; border: 1px solid #e2e8f0;">
                <tr>
                  <td>
                    <div style="font-size: 13px; font-weight: 700; color: #0c3529; margin-bottom: 8px;">How to check your result:</div>
                    <ol style="margin: 0; padding-left: 20px; font-size: 13px; color: #475569; line-height: 1.6;">
                      <li>Visit the official result checker portal${input.resultCheckerUrl ? ' linked above' : ''}.</li>
                      <li>Enter your Index Number, Exam Type, and Exam Year.</li>
                      <li>Enter your <strong>Serial Number</strong> and <strong>PIN</strong> exactly as shown above.</li>
                      <li>Submit to view and print your official result slip.</li>
                    </ol>
                  </td>
                </tr>
              </table>
              <table width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-bottom: 20px;">
                <tr>
                  <td style="background-color: #f1f5f9; border-radius: 8px; padding: 12px 16px; font-size: 13px; color: #475569; line-height: 1.5;">
                    📎 <strong>PDF &amp; CSV Copies:</strong> Printable PDF and spreadsheet CSV copies of this voucher are attached to this email for your records.
                  </td>
                </tr>
              </table>
              <p style="margin: 0; font-size: 12px; color: #94a3b8; text-align: center; line-height: 1.4;">
                🔒 Keep this PIN secure. EduVoucher support will never ask you to share your PIN publicly.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 20px 32px; text-align: center;">
              <p style="margin: 0 0 6px 0; font-size: 13px; color: #64748b;">
                Need help? Contact support: <strong style="color: #0c3529;">${escapeHtml(input.supportPhone)}</strong>
              </p>
              <p style="margin: 0; font-size: 12px; color: #94a3b8;">
                &copy; EduVoucher &bull; <a href="https://eduvoucherstore.com" target="_blank" rel="noopener noreferrer" style="color: #23674d; text-decoration: none; font-weight: 600;">eduvoucherstore.com</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
