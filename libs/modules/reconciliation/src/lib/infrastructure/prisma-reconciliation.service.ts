import { Prisma } from '../../../../../../generated/prisma/client';

import type { DatabaseClient } from '@edu-api/database';

import {
  reconciliationFingerprint,
  type ReconciliationCycleResult,
  type ReconciliationService,
} from '../application/reconciliation-service';

interface DetectedFinding {
  readonly details: Readonly<Record<string, number | string>>;
  readonly sourcePublicReference: string;
  readonly summary: string;
  readonly type: string;
}

export class PrismaReconciliationService implements ReconciliationService {
  constructor(private readonly database: DatabaseClient) {}

  async process(limit: number): Promise<ReconciliationCycleResult> {
    const bounded = Math.max(1, Math.min(limit, 100));
    const resolved = await this.resolveClearedFindings(bounded);
    const perType = Math.max(1, Math.floor(bounded / 6));
    const groups = await Promise.all([
      this.findInventoryCountMismatches(perType),
      this.findPaidFulfilmentCountMismatches(perType),
      this.findSoldVoucherMismatches(perType),
      this.findAvailableVoucherMismatches(perType),
      this.findAllocationMarkerMismatches(perType),
      this.findUnsuccessfulPaymentAllocations(perType),
    ]);
    const findings = groups.flat().slice(0, bounded);
    const now = new Date();
    for (const finding of findings) {
      await this.database.reconciliationFinding.upsert({
        where: {
          fingerprint: reconciliationFingerprint(
            finding.type,
            finding.sourcePublicReference,
          ),
        },
        create: {
          details: finding.details,
          fingerprint: reconciliationFingerprint(
            finding.type,
            finding.sourcePublicReference,
          ),
          severity: 'ERROR',
          summary: finding.summary,
          type: finding.type,
        },
        update: {
          details: finding.details,
          lastDetectedAt: now,
          occurrenceCount: { increment: 1 },
          resolvedAt: null,
          status: 'OPEN',
          summary: finding.summary,
        },
      });
    }
    return { detected: findings.length, resolved };
  }

  private async resolveClearedFindings(limit: number): Promise<number> {
    const open = await this.database.reconciliationFinding.findMany({
      where: { status: 'OPEN' },
      orderBy: [{ lastDetectedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, details: true, type: true },
    });
    let resolved = 0;
    for (const finding of open) {
      const source = sourceReference(finding.details);
      if (source === null || (await this.stillPresent(finding.type, source))) {
        continue;
      }
      const changed = await this.database.reconciliationFinding.updateMany({
        where: { id: finding.id, status: 'OPEN' },
        data: { resolvedAt: new Date(), status: 'RESOLVED' },
      });
      resolved += changed.count;
    }
    return resolved;
  }

  private async stillPresent(type: string, source: string): Promise<boolean> {
    if (type === 'INVENTORY_COUNT_MISMATCH') {
      const batch = await this.database.voucherBatch.findUnique({
        where: { publicId: source },
        select: {
          importState: true,
          totalQuantity: true,
          _count: { select: { vouchers: true } },
        },
      });
      return (
        batch !== null &&
        batch.importState === 'IMPORTED' &&
        batch.totalQuantity !== batch._count.vouchers
      );
    }
    if (type === 'PAID_FULFILMENT_COUNT_MISMATCH') {
      const order = await this.database.order.findUnique({
        where: { publicReference: source },
        select: {
          paymentApplication: { select: { id: true } },
          items: {
            select: {
              quantity: true,
              _count: { select: { fulfilmentUnits: true } },
            },
          },
        },
      });
      return (
        order !== null &&
        order.paymentApplication !== null &&
        order.items.some(
          (item) => item.quantity !== item._count.fulfilmentUnits,
        )
      );
    }
    if (
      type === 'SOLD_VOUCHER_WITHOUT_ALLOCATION' ||
      type === 'AVAILABLE_VOUCHER_WITH_ALLOCATION'
    ) {
      const voucher = await this.database.voucher.findUnique({
        where: { publicId: source },
        select: { status: true, allocation: { select: { id: true } } },
      });
      return (
        voucher !== null &&
        (type === 'SOLD_VOUCHER_WITHOUT_ALLOCATION'
          ? voucher.status === 'SOLD' && voucher.allocation === null
          : voucher.status === 'AVAILABLE' && voucher.allocation !== null)
      );
    }
    if (type === 'FULFILMENT_ALLOCATION_MARKER_MISMATCH') {
      const unit = await this.database.fulfilmentUnit.findUnique({
        where: { publicReference: source },
        select: { allocatedAt: true, allocation: { select: { id: true } } },
      });
      return (
        unit !== null &&
        (unit.allocatedAt === null) !== (unit.allocation === null)
      );
    }
    if (type === 'ALLOCATION_TO_UNSUCCESSFUL_PAYMENT') {
      const allocation = await this.database.voucherAllocation.findUnique({
        where: { publicReference: source },
        select: {
          fulfilmentUnit: {
            select: {
              paymentApplication: {
                select: { paymentAttempt: { select: { status: true } } },
              },
            },
          },
        },
      });
      return (
        allocation !== null &&
        allocation.fulfilmentUnit.paymentApplication.paymentAttempt.status !==
          'SUCCEEDED'
      );
    }
    return true;
  }

  private async findInventoryCountMismatches(
    limit: number,
  ): Promise<DetectedFinding[]> {
    const rows = await this.database.$queryRaw<
      readonly { publicReference: string; expected: number; actual: bigint }[]
    >`
      SELECT b."publicId" AS "publicReference", b."totalQuantity" AS expected, COUNT(v.id) AS actual
      FROM "VoucherBatch" b
      LEFT JOIN "Voucher" v ON v."batchId" = b.id
      WHERE b."importState" = 'IMPORTED'
      GROUP BY b.id
      HAVING b."totalQuantity"::bigint <> COUNT(v.id)
      ORDER BY b.id ASC
      LIMIT ${limit}
    `;
    return rows.map((row) =>
      finding(
        'INVENTORY_COUNT_MISMATCH',
        row.publicReference,
        'Imported voucher batch quantity does not equal available plus sold vouchers.',
        {
          expectedQuantity: row.expected,
          actualQuantity: row.actual.toString(),
        },
      ),
    );
  }

  private async findPaidFulfilmentCountMismatches(
    limit: number,
  ): Promise<DetectedFinding[]> {
    const rows = await this.database.$queryRaw<
      readonly { publicReference: string; expected: number; actual: bigint }[]
    >`
      SELECT o."publicReference", oi.quantity AS expected, COUNT(fu.id) AS actual
      FROM "PaymentApplication" pa
      JOIN "Order" o ON o.id = pa."orderId"
      JOIN "OrderItem" oi ON oi."orderId" = o.id
      LEFT JOIN "FulfilmentUnit" fu ON fu."orderItemId" = oi.id
      GROUP BY o.id, oi.id
      HAVING oi.quantity::bigint <> COUNT(fu.id)
      ORDER BY o.id ASC
      LIMIT ${limit}
    `;
    return rows.map((row) =>
      finding(
        'PAID_FULFILMENT_COUNT_MISMATCH',
        row.publicReference,
        'Paid voucher quantity does not equal allocated plus waiting fulfilment units.',
        {
          expectedQuantity: row.expected,
          actualQuantity: row.actual.toString(),
        },
      ),
    );
  }

  private async findSoldVoucherMismatches(
    limit: number,
  ): Promise<DetectedFinding[]> {
    const rows = await this.database.$queryRaw<
      readonly { publicReference: string }[]
    >`
      SELECT v."publicId" AS "publicReference" FROM "Voucher" v
      LEFT JOIN "VoucherAllocation" a ON a."voucherId" = v.id
      WHERE v.status = 'SOLD' AND a.id IS NULL ORDER BY v.id ASC LIMIT ${limit}
    `;
    return rows.map((row) =>
      finding(
        'SOLD_VOUCHER_WITHOUT_ALLOCATION',
        row.publicReference,
        'A sold voucher has no allocation.',
        {},
      ),
    );
  }

  private async findAvailableVoucherMismatches(
    limit: number,
  ): Promise<DetectedFinding[]> {
    const rows = await this.database.$queryRaw<
      readonly { publicReference: string }[]
    >`
      SELECT v."publicId" AS "publicReference" FROM "Voucher" v
      JOIN "VoucherAllocation" a ON a."voucherId" = v.id
      WHERE v.status = 'AVAILABLE' ORDER BY v.id ASC LIMIT ${limit}
    `;
    return rows.map((row) =>
      finding(
        'AVAILABLE_VOUCHER_WITH_ALLOCATION',
        row.publicReference,
        'An available voucher is already allocated.',
        {},
      ),
    );
  }

  private async findAllocationMarkerMismatches(
    limit: number,
  ): Promise<DetectedFinding[]> {
    const rows = await this.database.$queryRaw<
      readonly { publicReference: string }[]
    >`
      SELECT fu."publicReference" FROM "FulfilmentUnit" fu
      LEFT JOIN "VoucherAllocation" a ON a."fulfilmentUnitId" = fu.id
      WHERE (fu."allocatedAt" IS NULL) <> (a.id IS NULL)
      ORDER BY fu.id ASC LIMIT ${limit}
    `;
    return rows.map((row) =>
      finding(
        'FULFILMENT_ALLOCATION_MARKER_MISMATCH',
        row.publicReference,
        'A fulfilment allocation and its allocated timestamp disagree.',
        {},
      ),
    );
  }

  private async findUnsuccessfulPaymentAllocations(
    limit: number,
  ): Promise<DetectedFinding[]> {
    const rows = await this.database.$queryRaw<
      readonly { publicReference: string; paymentStatus: string }[]
    >`
      SELECT a."publicReference", p.status::text AS "paymentStatus"
      FROM "VoucherAllocation" a
      JOIN "FulfilmentUnit" fu ON fu.id = a."fulfilmentUnitId"
      JOIN "PaymentApplication" pa ON pa.id = fu."paymentApplicationId"
      JOIN "PaymentAttempt" p ON p.id = pa."paymentAttemptId"
      WHERE p.status <> 'SUCCEEDED'
      ORDER BY a.id ASC LIMIT ${limit}
    `;
    return rows.map((row) =>
      finding(
        'ALLOCATION_TO_UNSUCCESSFUL_PAYMENT',
        row.publicReference,
        'A voucher allocation references a payment that is not successful.',
        { paymentStatus: row.paymentStatus },
      ),
    );
  }
}

function finding(
  type: string,
  sourcePublicReference: string,
  summary: string,
  details: Readonly<Record<string, number | string>>,
): DetectedFinding {
  return {
    type,
    sourcePublicReference,
    summary,
    details: { sourcePublicReference, ...details },
  };
}

function sourceReference(details: Prisma.JsonValue): string | null {
  return typeof details === 'object' &&
    details !== null &&
    !Array.isArray(details) &&
    typeof details.sourcePublicReference === 'string'
    ? details.sourcePublicReference
    : null;
}
