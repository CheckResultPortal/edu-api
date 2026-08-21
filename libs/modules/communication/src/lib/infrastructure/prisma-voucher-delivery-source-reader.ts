import type { DatabaseTransactionClient } from '@edu-api/database';

export interface VoucherDeliverySource {
  readonly allocationId: bigint;
  readonly encryptedPin: unknown;
  readonly orderPublicReference: string;
  readonly preference: 'SMS_ONLY' | 'EMAIL_ONLY' | 'SMS_AND_EMAIL';
  readonly destinationEmail: string | null;
  readonly destinationPhone: string | null;
  readonly serialNumber: string;
}

/** Read-only facade over allocated-voucher and order-contact facts. */
export class PrismaVoucherDeliverySourceReader {
  async findByAllocationPublicReference(
    transaction: DatabaseTransactionClient,
    allocationPublicReference: string,
  ): Promise<VoucherDeliverySource | null> {
    const allocation = await transaction.voucherAllocation.findUnique({
      where: { publicReference: allocationPublicReference },
      select: {
        id: true,
        voucher: { select: { encryptedPin: true, serialNumber: true } },
        fulfilmentUnit: {
          select: {
            orderPublicReference: true,
            orderItem: {
              select: {
                order: {
                  select: {
                    contactAnonymizedAt: true,
                    deliveryPreference: true,
                    email: true,
                    phoneNumber: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (allocation === null) return null;
    const order = allocation.fulfilmentUnit.orderItem.order;
    return {
      allocationId: allocation.id,
      destinationEmail: order.contactAnonymizedAt === null ? order.email : null,
      destinationPhone:
        order.contactAnonymizedAt === null ? order.phoneNumber : null,
      encryptedPin: allocation.voucher.encryptedPin,
      orderPublicReference: allocation.fulfilmentUnit.orderPublicReference,
      preference: order.deliveryPreference,
      serialNumber: allocation.voucher.serialNumber,
    };
  }
}
