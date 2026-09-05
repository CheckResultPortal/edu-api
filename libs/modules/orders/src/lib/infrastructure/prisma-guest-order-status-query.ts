import type { DatabaseClient } from '@edu-api/database';
import type { Prisma } from '../../../../../../generated/prisma/client';

import type {
  GuestOrderLifecycleStatus,
  GuestOrderRetrievalAccess,
  GuestOrderStatusQuery,
  GuestOrderSummary,
} from '../application/guest-order-status-query';

export class PrismaGuestOrderStatusQuery implements GuestOrderStatusQuery {
  constructor(private readonly database: DatabaseClient) {}

  async findByPhoneAndEmail(
    phoneNumber: string,
    email: string,
  ): Promise<readonly GuestOrderSummary[]> {
    const orders = await this.database.order.findMany({
      where: { phoneNumber, email, contactAnonymizedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 20,
      select: ORDER_SELECT,
    });

    return orders.map(summarizeOrder);
  }

  async findByPhoneAndReference(
    phoneNumber: string,
    orderReference: string,
  ): Promise<GuestOrderSummary | null> {
    const order = await this.database.order.findFirst({
      where: {
        phoneNumber,
        publicReference: orderReference,
        contactAnonymizedAt: null,
      },
      select: ORDER_SELECT,
    });
    return order === null ? null : summarizeOrder(order);
  }

  async findVoucherRetrievalAccess(input: {
    readonly email?: string;
    readonly orderReference: string;
    readonly phoneNumber?: string;
  }): Promise<GuestOrderRetrievalAccess | null> {
    if (input.email === undefined && input.phoneNumber === undefined)
      return null;
    const order = await this.database.order.findFirst({
      where: {
        publicReference: input.orderReference,
        contactAnonymizedAt: null,
        ...(input.email === undefined ? {} : { email: input.email }),
        ...(input.phoneNumber === undefined
          ? {}
          : { phoneNumber: input.phoneNumber }),
      },
      select: {
        id: true,
        email: true,
        paymentApplication: { select: { id: true } },
        items: {
          select: { fulfilmentUnits: { select: { allocatedAt: true } } },
        },
      },
    });
    if (
      order === null ||
      order.email === null ||
      order.paymentApplication === null ||
      !hasEveryUnitAllocated(order.items[0]?.fulfilmentUnits ?? [])
    ) {
      return null;
    }

    return { destinationEmail: order.email, orderId: order.id };
  }
}

const ORDER_SELECT = {
  publicReference: true,
  email: true,
  totalPriceMinor: true,
  currency: true,
  createdAt: true,
  paymentApplication: { select: { appliedAt: true } },
  paymentAttempts: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { status: true },
  },
  items: {
    select: {
      quantity: true,
      product: { select: { name: true } },
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

function summarizeOrder(order: {
  publicReference: string;
  email: string | null;
  totalPriceMinor: bigint;
  currency: string;
  createdAt: Date;
  paymentApplication: { appliedAt: Date } | null;
  paymentAttempts: readonly { status: string }[];
  items: readonly {
    quantity: number;
    product: { name: string };
    fulfilmentUnits: readonly {
      allocatedAt: Date | null;
      allocation: {
        communication: {
          deliveries: readonly { state: string }[];
        } | null;
      } | null;
    }[];
  }[];
}): GuestOrderSummary {
  const item = order.items[0];
  const units = item?.fulfilmentUnits ?? [];
  const deliveries = units.flatMap((unit) =>
    (unit.allocation?.communication?.deliveries ?? []).map(
      (delivery) => delivery.state,
    ),
  );

  return {
    canRequestVoucherEmail:
      order.email !== null &&
      order.paymentApplication !== null &&
      hasEveryUnitAllocated(units),
    publicReference: order.publicReference,
    productName: item?.product.name ?? 'Unknown product',
    quantity: units.length || (item?.quantity ?? 0),
    totalPriceMinor: order.totalPriceMinor.toString(),
    currency: order.currency,
    status: deriveLifecycleStatus(
      order.paymentApplication,
      order.paymentAttempts,
      units,
      deliveries,
    ),
    createdAt: order.createdAt,
  };
}

function hasEveryUnitAllocated(
  units: readonly { allocatedAt: Date | null }[],
): boolean {
  return units.length > 0 && units.every((unit) => unit.allocatedAt !== null);
}

function deriveLifecycleStatus(
  paymentApplication: { appliedAt: Date } | null,
  paymentAttempts: readonly { status: string }[],
  units: readonly { allocatedAt: Date | null }[],
  deliveries: readonly string[],
): GuestOrderLifecycleStatus {
  if (paymentApplication === null) {
    const hasAttempts = paymentAttempts.length > 0;
    const allFailed = paymentAttempts.every(
      (attempt) => attempt.status === 'FAILED',
    );
    if (hasAttempts && allFailed) return 'PAYMENT_FAILED';
    return 'PAYMENT_PENDING';
  }

  if (!hasEveryUnitAllocated(units)) return 'WAITING_FOR_STOCK';

  if (
    deliveries.some((state) => ['NEEDS_ATTENTION', 'UNKNOWN'].includes(state))
  ) {
    return 'DELIVERY_ISSUE';
  }

  if (deliveries.length > 0 && deliveries.every((state) => state === 'SENT')) {
    return 'DELIVERED';
  }

  return 'DELIVERY_IN_PROGRESS';
}
