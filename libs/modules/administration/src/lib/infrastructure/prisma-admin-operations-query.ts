import type { Prisma } from '../../../../../../generated/prisma/client';

import type { DatabaseClient } from '@edu-api/database';

import type {
  AdminJsonValue,
  AdminOperationsQuery,
  AdminQueryPage,
} from '../application/admin-operations-query';

export class PrismaAdminOperationsQuery implements AdminOperationsQuery {
  constructor(private readonly database: DatabaseClient) {}

  async getDashboard(input: { readonly from: Date; readonly to: Date }) {
    const paidWindow = {
      paymentApplication: {
        is: { appliedAt: { gte: input.from, lt: input.to } },
      },
    } satisfies Prisma.OrderWhereInput;
    const fulfilmentWindow = {
      paidAt: { gte: input.from, lt: input.to },
    } satisfies Prisma.FulfilmentUnitWhereInput;
    const [
      ordersCreated,
      paidOrders,
      sales,
      paidQuantity,
      allocatedQuantity,
      waitingQuantity,
      oldestWaiting,
      voucherStates,
      paymentStates,
      deliveryStates,
      latestStockAlerts,
      reconciliationStates,
      oldestOpenFinding,
    ] = await Promise.all([
      this.database.order.count({
        where: { createdAt: { gte: input.from, lt: input.to } },
      }),
      this.database.order.count({ where: paidWindow }),
      this.database.order.aggregate({
        where: paidWindow,
        _sum: { totalPriceMinor: true },
      }),
      this.database.orderItem.aggregate({
        where: { order: paidWindow },
        _sum: { quantity: true },
      }),
      this.database.fulfilmentUnit.count({
        where: { ...fulfilmentWindow, allocatedAt: { not: null } },
      }),
      this.database.fulfilmentUnit.count({ where: { allocatedAt: null } }),
      this.database.fulfilmentUnit.findFirst({
        where: { allocatedAt: null },
        orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
        select: { paidAt: true },
      }),
      this.database.voucher.groupBy({ by: ['status'], _count: { _all: true } }),
      this.database.paymentAttempt.groupBy({
        by: ['status'],
        where: { createdAt: { gte: input.from, lt: input.to } },
        _count: { _all: true },
      }),
      this.database.communicationDelivery.groupBy({
        by: ['channel', 'state'],
        _count: { _all: true },
      }),
      this.database.stockAlert.findMany({
        take: 10,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        select: {
          availableStock: true,
          occurredAt: true,
          paidWaitingQuantity: true,
          state: true,
          product: { select: { name: true, publicId: true } },
        },
      }),
      this.database.reconciliationFinding.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.database.reconciliationFinding.findFirst({
        where: { status: 'OPEN' },
        orderBy: [{ firstDetectedAt: 'asc' }, { id: 'asc' }],
        select: { firstDetectedAt: true },
      }),
    ]);
    return {
      window: { from: input.from.toISOString(), to: input.to.toISOString() },
      currency: 'GHS',
      ordersCreated,
      paidOrders,
      grossSalesMinor: (sales._sum.totalPriceMinor ?? BigInt(0)).toString(),
      paidVoucherQuantity: paidQuantity._sum.quantity ?? 0,
      allocatedVoucherQuantity: allocatedQuantity,
      waitingVoucherQuantity: waitingQuantity,
      oldestWaitingPaidAt: oldestWaiting?.paidAt.toISOString() ?? null,
      voucherStates: Object.fromEntries(
        voucherStates.map((entry) => [entry.status, entry._count._all]),
      ),
      paymentStates: Object.fromEntries(
        paymentStates.map((entry) => [entry.status, entry._count._all]),
      ),
      deliveryStates: deliveryStates.map((entry) => ({
        channel: entry.channel,
        count: entry._count._all,
        state: entry.state,
      })),
      latestStockAlerts: latestStockAlerts.map((alert) => ({
        availableStock: alert.availableStock.toString(),
        occurredAt: alert.occurredAt.toISOString(),
        paidWaitingQuantity: alert.paidWaitingQuantity.toString(),
        productName: alert.product.name,
        productPublicId: alert.product.publicId,
        state: alert.state,
      })),
      reconciliationStates: Object.fromEntries(
        reconciliationStates.map((entry) => [entry.status, entry._count._all]),
      ),
      oldestOpenReconciliationFindingAt:
        oldestOpenFinding?.firstDetectedAt.toISOString() ?? null,
    };
  }

  async listOrders(input: {
    readonly channel?: 'USSD' | 'WEB';
    readonly cursor?: string;
    readonly from?: Date;
    readonly limit: number;
    readonly query?: string;
    readonly status?:
      | 'ALLOCATED'
      | 'COMPLETE'
      | 'DELIVERY_ISSUE'
      | 'PAID'
      | 'UNPAID'
      | 'WAITING';
    readonly to?: Date;
  }): Promise<AdminQueryPage> {
    const where: Prisma.OrderWhereInput = {
      ...(input.channel === undefined
        ? {}
        : { purchaseChannel: input.channel }),
      ...(input.from === undefined && input.to === undefined
        ? {}
        : {
            createdAt: {
              ...(input.from === undefined ? {} : { gte: input.from }),
              ...(input.to === undefined ? {} : { lt: input.to }),
            },
          }),
      ...statusWhere(input.status),
      ...(input.query === undefined ? {} : searchWhere(input.query)),
    };
    const orders = await this.database.order.findMany({
      where,
      ...(input.cursor === undefined
        ? {}
        : { cursor: { publicReference: input.cursor }, skip: 1 }),
      take: input.limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: orderSummarySelection,
    });
    const hasMore = orders.length > input.limit;
    const page = orders.slice(0, input.limit);
    return {
      items: page.map(orderSummary),
      nextCursor: hasMore ? (page.at(-1)?.publicReference ?? null) : null,
    };
  }

  async getOrder(orderPublicReference: string) {
    const order = await this.database.order.findUnique({
      where: { publicReference: orderPublicReference },
      select: {
        publicReference: true,
        purchaseChannel: true,
        deliveryPreference: true,
        phoneNumber: true,
        email: true,
        contactAnonymizedAt: true,
        totalPriceMinor: true,
        currency: true,
        createdAt: true,
        updatedAt: true,
        items: {
          select: {
            quantity: true,
            unitPriceMinor: true,
            totalPriceMinor: true,
            product: { select: { name: true, publicId: true } },
            fulfilmentUnits: {
              orderBy: { ordinal: 'asc' },
              select: {
                publicReference: true,
                ordinal: true,
                paidAt: true,
                allocatedAt: true,
                createdAt: true,
                allocation: {
                  select: {
                    publicReference: true,
                    allocatedAt: true,
                    voucher: { select: { serialNumber: true } },
                    communication: {
                      select: {
                        publicId: true,
                        createdAt: true,
                        deliveries: {
                          orderBy: [{ channel: 'asc' }, { id: 'asc' }],
                          select: {
                            publicId: true,
                            channel: true,
                            destination: true,
                            state: true,
                            attemptCount: true,
                            nextAttemptAt: true,
                            sentAt: true,
                            lastFailureCategory: true,
                            needsAttentionAt: true,
                            createdAt: true,
                            updatedAt: true,
                            attempts: {
                              orderBy: { attemptNumber: 'asc' },
                              select: {
                                attemptNumber: true,
                                provider: true,
                                outcome: true,
                                providerCode: true,
                                startedAt: true,
                                completedAt: true,
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        paymentAttempts: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            publicReference: true,
            provider: true,
            providerReference: true,
            status: true,
            expectedAmountMinor: true,
            currency: true,
            providerTransactionId: true,
            providerStatus: true,
            paidAt: true,
            verifiedAt: true,
            nextVerificationAt: true,
            verificationAttempts: true,
            needsAttentionAt: true,
            attentionReason: true,
            createdAt: true,
            updatedAt: true,
            providerEvents: {
              orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
              select: {
                eventType: true,
                providerReference: true,
                providerTransactionId: true,
                outcome: true,
                rejectionReason: true,
                receivedAt: true,
                processedAt: true,
              },
            },
          },
        },
        paymentApplication: {
          select: { appliedAt: true, createdAt: true },
        },
      },
    });
    if (order === null) return null;
    return {
      id: order.publicReference,
      attributes: serialize(order) as {
        readonly [key: string]: AdminJsonValue;
      },
    };
  }

  async listInventory(input: {
    readonly cursor?: string;
    readonly limit: number;
    readonly query?: string;
  }): Promise<AdminQueryPage> {
    const products = await this.database.product.findMany({
      where:
        input.query === undefined
          ? undefined
          : {
              OR: [
                { code: { contains: input.query, mode: 'insensitive' } },
                { name: { contains: input.query, mode: 'insensitive' } },
                ...(isUuid(input.query)
                  ? [{ publicId: input.query } as const]
                  : []),
              ],
            },
      ...(input.cursor === undefined
        ? {}
        : { cursor: { publicId: input.cursor }, skip: 1 }),
      take: input.limit + 1,
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }, { publicId: 'asc' }],
      select: {
        id: true,
        publicId: true,
        code: true,
        name: true,
        isActive: true,
        lowStockThreshold: true,
        sellingPriceMinor: true,
        currency: true,
        sortOrder: true,
        catalogGroup: { select: { publicId: true, name: true } },
        stockMonitoringState: { select: { state: true, updatedAt: true } },
      },
    });
    const hasMore = products.length > input.limit;
    const page = products.slice(0, input.limit);
    const productIds = page.map((product) => product.id);
    const [voucherCounts, batchTotals, waitingCounts] = await Promise.all([
      this.database.voucher.groupBy({
        by: ['productId', 'status'],
        where: { productId: { in: productIds } },
        _count: { _all: true },
      }),
      this.database.voucherBatch.groupBy({
        by: ['productId'],
        where: { productId: { in: productIds }, importState: 'IMPORTED' },
        _sum: { totalQuantity: true },
      }),
      this.database.fulfilmentUnit.groupBy({
        by: ['productId'],
        where: { productId: { in: productIds }, allocatedAt: null },
        _count: { _all: true },
      }),
    ]);
    return {
      items: page.map((product) => ({
        id: product.publicId,
        attributes: {
          code: product.code,
          name: product.name,
          isActive: product.isActive,
          sellingPriceMinor: product.sellingPriceMinor.toString(),
          currency: product.currency,
          lowStockThreshold: product.lowStockThreshold,
          sortOrder: product.sortOrder,
          catalogGroupPublicId: product.catalogGroup.publicId,
          stockLevel: product.stockMonitoringState?.state ?? 'NORMAL',
          stockMeasuredAt:
            product.stockMonitoringState?.updatedAt.toISOString() ?? null,
          imported: countBatch(batchTotals, product.id).toString(),
          available: countVoucher(voucherCounts, product.id, 'AVAILABLE'),
          sold: countVoucher(voucherCounts, product.id, 'SOLD'),
          paidWaiting: countWaiting(waitingCounts, product.id),
        },
      })),
      nextCursor: hasMore ? (page.at(-1)?.publicId ?? null) : null,
    };
  }

  async listBacklog(input: {
    readonly cursor?: string;
    readonly limit: number;
    readonly productPublicId?: string;
  }): Promise<AdminQueryPage> {
    const units = await this.database.fulfilmentUnit.findMany({
      where: {
        allocatedAt: null,
        ...(input.productPublicId === undefined
          ? {}
          : { productPublicId: input.productPublicId }),
      },
      ...(input.cursor === undefined
        ? {}
        : { cursor: { publicReference: input.cursor }, skip: 1 }),
      take: input.limit + 1,
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
      select: {
        publicReference: true,
        orderPublicReference: true,
        ordinal: true,
        paidAt: true,
        createdAt: true,
        product: { select: { publicId: true, name: true } },
        paymentApplication: {
          select: {
            order: {
              select: {
                phoneNumber: true,
                email: true,
                purchaseChannel: true,
              },
            },
          },
        },
      },
    });
    const hasMore = units.length > input.limit;
    const page = units.slice(0, input.limit);
    return {
      items: page.map((unit) => ({
        id: unit.publicReference,
        attributes: serialize({
          ...unit,
          waitingAgeSeconds: Math.max(
            0,
            Math.floor((Date.now() - unit.paidAt.getTime()) / 1_000),
          ),
        }) as { readonly [key: string]: AdminJsonValue },
      })),
      nextCursor: hasMore ? (page.at(-1)?.publicReference ?? null) : null,
    };
  }

  async listDeliveries(input: {
    readonly channel?: 'EMAIL' | 'SMS';
    readonly cursor?: string;
    readonly limit: number;
    readonly state?:
      | 'NEEDS_ATTENTION'
      | 'PENDING'
      | 'PROCESSING'
      | 'RETRYING'
      | 'SENT'
      | 'UNKNOWN';
  }): Promise<AdminQueryPage> {
    const deliveries = await this.database.communicationDelivery.findMany({
      where: {
        ...(input.channel === undefined ? {} : { channel: input.channel }),
        ...(input.state === undefined ? {} : { state: input.state }),
      },
      ...(input.cursor === undefined
        ? {}
        : { cursor: { publicId: input.cursor }, skip: 1 }),
      take: input.limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        publicId: true,
        channel: true,
        destination: true,
        state: true,
        attemptCount: true,
        nextAttemptAt: true,
        sentAt: true,
        lastFailureCategory: true,
        needsAttentionAt: true,
        createdAt: true,
        updatedAt: true,
        attempts: {
          orderBy: { attemptNumber: 'desc' },
          take: 10,
          select: {
            attemptNumber: true,
            provider: true,
            outcome: true,
            providerCode: true,
            startedAt: true,
            completedAt: true,
          },
        },
        communication: {
          select: {
            allocation: {
              select: {
                publicReference: true,
                fulfilmentUnit: {
                  select: { orderPublicReference: true, publicReference: true },
                },
                voucher: { select: { serialNumber: true } },
              },
            },
          },
        },
      },
    });
    const hasMore = deliveries.length > input.limit;
    const page = deliveries.slice(0, input.limit);
    return {
      items: page.map((delivery) => ({
        id: delivery.publicId,
        attributes: serialize(delivery) as {
          readonly [key: string]: AdminJsonValue;
        },
      })),
      nextCursor: hasMore ? (page.at(-1)?.publicId ?? null) : null,
    };
  }

  async listAuditEvents(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<AdminQueryPage> {
    const cursor = decodeAuditCursor(input.cursor);
    const events = await this.database.adminSecurityEvent.findMany({
      where:
        cursor === null
          ? undefined
          : {
              OR: [
                { occurredAt: { lt: cursor.occurredAt } },
                { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
              ],
            },
      take: input.limit + 1,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        eventType: true,
        correlationId: true,
        metadata: true,
        occurredAt: true,
        adminUser: { select: { publicId: true, email: true, role: true } },
      },
    });
    const hasMore = events.length > input.limit;
    const page = events.slice(0, input.limit);
    return {
      items: page.map((event) => ({
        id: encodeAuditCursor(event.occurredAt, event.id),
        attributes: serialize({
          eventType: event.eventType,
          correlationId: event.correlationId,
          metadata: event.metadata,
          occurredAt: event.occurredAt,
          administrator: event.adminUser,
        }) as { readonly [key: string]: AdminJsonValue },
      })),
      nextCursor:
        hasMore && page.at(-1) !== undefined
          ? encodeAuditCursor(page.at(-1)!.occurredAt, page.at(-1)!.id)
          : null,
    };
  }

  async listVouchers(input: {
    readonly catalogGroupPublicId?: string;
    readonly cursor?: string;
    readonly limit: number;
    readonly productPublicId?: string;
    readonly serialNumber?: string;
    readonly status?: 'AVAILABLE' | 'SOLD';
  }): Promise<AdminQueryPage> {
    const vouchers = await this.database.voucher.findMany({
      where: {
        product: {
          ...(input.productPublicId === undefined
            ? {}
            : { publicId: input.productPublicId }),
          ...(input.catalogGroupPublicId === undefined
            ? {}
            : { catalogGroup: { publicId: input.catalogGroupPublicId } }),
        },
        ...(input.serialNumber === undefined
          ? {}
          : { serialNumber: input.serialNumber }),
        ...(input.status === undefined ? {} : { status: input.status }),
      },
      ...(input.cursor === undefined
        ? {}
        : { cursor: { publicId: input.cursor }, skip: 1 }),
      take: input.limit + 1,
      orderBy: { publicId: 'asc' },
      select: {
        publicId: true,
        serialNumber: true,
        status: true,
        soldAt: true,
        createdAt: true,
        updatedAt: true,
        product: { select: { publicId: true, name: true } },
        batch: {
          select: {
            publicId: true,
            reference: true,
            activatedAt: true,
            validUntil: true,
          },
        },
        allocation: {
          select: {
            publicReference: true,
            allocatedAt: true,
            fulfilmentUnit: {
              select: { publicReference: true, orderPublicReference: true },
            },
            communication: {
              select: {
                deliveries: {
                  select: {
                    publicId: true,
                    channel: true,
                    state: true,
                    sentAt: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    const hasMore = vouchers.length > input.limit;
    const page = vouchers.slice(0, input.limit);
    return {
      items: page.map((voucher) => ({
        id: voucher.publicId,
        attributes: serialize(voucher) as {
          readonly [key: string]: AdminJsonValue;
        },
      })),
      nextCursor: hasMore ? (page.at(-1)?.publicId ?? null) : null,
    };
  }

  async listReconciliationFindings(input: {
    readonly cursor?: string;
    readonly limit: number;
    readonly status?: 'OPEN' | 'RESOLVED';
    readonly type?: string;
  }): Promise<AdminQueryPage> {
    const findings = await this.database.reconciliationFinding.findMany({
      where: {
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.type === undefined ? {} : { type: input.type }),
      },
      ...(input.cursor === undefined
        ? {}
        : { cursor: { publicId: input.cursor }, skip: 1 }),
      take: input.limit + 1,
      orderBy: { publicId: 'asc' },
      select: {
        publicId: true,
        type: true,
        severity: true,
        status: true,
        summary: true,
        details: true,
        occurrenceCount: true,
        firstDetectedAt: true,
        lastDetectedAt: true,
        resolvedAt: true,
      },
    });
    const hasMore = findings.length > input.limit;
    const page = findings.slice(0, input.limit);
    return {
      items: page.map((finding) => ({
        id: finding.publicId,
        attributes: serialize(finding) as {
          readonly [key: string]: AdminJsonValue;
        },
      })),
      nextCursor: hasMore ? (page.at(-1)?.publicId ?? null) : null,
    };
  }
}

const orderSummarySelection = {
  publicReference: true,
  purchaseChannel: true,
  deliveryPreference: true,
  phoneNumber: true,
  email: true,
  totalPriceMinor: true,
  currency: true,
  createdAt: true,
  paymentApplication: { select: { appliedAt: true } },
  items: {
    select: {
      quantity: true,
      product: { select: { publicId: true, name: true } },
      fulfilmentUnits: {
        select: {
          allocatedAt: true,
          allocation: {
            select: {
              communication: {
                select: { deliveries: { select: { state: true } } },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.OrderSelect;

type OrderSummaryRow = Prisma.OrderGetPayload<{
  select: typeof orderSummarySelection;
}>;

function orderSummary(order: OrderSummaryRow) {
  const item = order.items[0];
  const units = item?.fulfilmentUnits ?? [];
  const deliveryStates = units.flatMap(
    (unit) => unit.allocation?.communication?.deliveries ?? [],
  );
  return {
    id: order.publicReference,
    attributes: {
      purchaseChannel: order.purchaseChannel,
      deliveryPreference: order.deliveryPreference,
      guest: {
        phoneNumber: order.phoneNumber,
        email: order.email,
      },
      productPublicId: item?.product.publicId ?? null,
      productName: item?.product.name ?? null,
      quantity: item?.quantity ?? 0,
      totalPriceMinor: order.totalPriceMinor.toString(),
      currency: order.currency,
      createdAt: order.createdAt.toISOString(),
      paidAt: order.paymentApplication?.appliedAt.toISOString() ?? null,
      allocatedQuantity: units.filter((unit) => unit.allocatedAt !== null)
        .length,
      waitingQuantity: units.filter((unit) => unit.allocatedAt === null).length,
      deliveryStates: deliveryStates.map((delivery) => delivery.state),
      lifecycleState: lifecycleState(order, units, deliveryStates),
    },
  };
}

function lifecycleState(
  order: OrderSummaryRow,
  units: OrderSummaryRow['items'][number]['fulfilmentUnits'],
  deliveries: readonly { readonly state: string }[],
): string {
  if (order.paymentApplication === null) return 'UNPAID';
  if (units.some((unit) => unit.allocatedAt === null)) return 'WAITING';
  if (
    deliveries.some((delivery) =>
      ['NEEDS_ATTENTION', 'UNKNOWN'].includes(delivery.state),
    )
  ) {
    return 'DELIVERY_ISSUE';
  }
  if (deliveries.length !== 0 && deliveries.every((d) => d.state === 'SENT')) {
    return 'COMPLETE';
  }
  return 'ALLOCATED';
}

function statusWhere(status: string | undefined): Prisma.OrderWhereInput {
  if (status === undefined) return {};
  if (status === 'UNPAID') return { paymentApplication: { is: null } };
  if (status === 'PAID') return { paymentApplication: { isNot: null } };
  if (status === 'WAITING') {
    return {
      paymentApplication: { isNot: null },
      items: { some: { fulfilmentUnits: { some: { allocatedAt: null } } } },
    };
  }
  if (status === 'DELIVERY_ISSUE') {
    return {
      items: {
        some: {
          fulfilmentUnits: {
            some: {
              allocation: {
                is: {
                  communication: {
                    is: {
                      deliveries: {
                        some: { state: { in: ['NEEDS_ATTENTION', 'UNKNOWN'] } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
  }
  const allocated: Prisma.OrderWhereInput = {
    paymentApplication: { isNot: null },
    items: {
      some: {
        fulfilmentUnits: {
          some: {},
          none: { allocatedAt: null },
        },
      },
    },
  };
  if (status === 'ALLOCATED') return allocated;
  return {
    ...allocated,
    items: {
      some: {
        fulfilmentUnits: {
          some: {
            allocation: {
              is: {
                communication: {
                  is: { deliveries: { some: {}, every: { state: 'SENT' } } },
                },
              },
            },
          },
        },
      },
    },
  };
}

function searchWhere(query: string): Prisma.OrderWhereInput {
  const normalized = query.trim();
  const phone = /^0[0-9]{9}$/.test(normalized)
    ? `+233${normalized.slice(1)}`
    : normalized;
  return {
    OR: [
      ...(isUuid(normalized) ? [{ publicReference: normalized }] : []),
      { phoneNumber: phone },
      { email: normalized.toLowerCase() },
      {
        paymentAttempts: {
          some: {
            OR: [
              { providerReference: normalized },
              ...(isUuid(normalized) ? [{ publicReference: normalized }] : []),
            ],
          },
        },
      },
      {
        items: {
          some: {
            fulfilmentUnits: {
              some: {
                allocation: { is: { voucher: { serialNumber: normalized } } },
              },
            },
          },
        },
      },
    ],
  };
}

function serialize(value: unknown): AdminJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, serialize(entry)]),
    );
  }
  return null;
}

function countVoucher(
  rows: readonly {
    readonly productId: bigint;
    readonly status: 'AVAILABLE' | 'SOLD';
    readonly _count: { readonly _all: number };
  }[],
  productId: bigint,
  status: 'AVAILABLE' | 'SOLD',
): number {
  return (
    rows.find((row) => row.productId === productId && row.status === status)
      ?._count._all ?? 0
  );
}

function countBatch(
  rows: readonly {
    readonly productId: bigint;
    readonly _sum: { readonly totalQuantity: number | null };
  }[],
  productId: bigint,
): bigint {
  return BigInt(
    rows.find((row) => row.productId === productId)?._sum.totalQuantity ?? 0,
  );
}

function countWaiting(
  rows: readonly {
    readonly productId: bigint;
    readonly _count: { readonly _all: number };
  }[],
  productId: bigint,
): number {
  return rows.find((row) => row.productId === productId)?._count._all ?? 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function encodeAuditCursor(occurredAt: Date, id: bigint): string {
  return Buffer.from(`${occurredAt.toISOString()}|${id.toString()}`).toString(
    'base64url',
  );
}

function decodeAuditCursor(
  value: string | undefined,
): { readonly id: bigint; readonly occurredAt: Date } | null {
  if (value === undefined) return null;
  try {
    const [timestamp, id] = Buffer.from(value, 'base64url')
      .toString('utf8')
      .split('|');
    const occurredAt = new Date(timestamp);
    if (
      Number.isNaN(occurredAt.getTime()) ||
      id === undefined ||
      !/^[1-9]\d*$/.test(id)
    ) {
      throw new Error('invalid');
    }
    return { id: BigInt(id), occurredAt };
  } catch {
    throw new Error('Admin audit cursor is invalid.');
  }
}
