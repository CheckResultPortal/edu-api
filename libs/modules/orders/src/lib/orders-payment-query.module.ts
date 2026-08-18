import { Module } from '@nestjs/common';

import { PAYMENT_ORDER_QUERY } from './application/payment-order-query';
import { PrismaPaymentOrderQuery } from './infrastructure/prisma-payment-order-query';

@Module({
  providers: [
    {
      provide: PAYMENT_ORDER_QUERY,
      useClass: PrismaPaymentOrderQuery,
    },
  ],
  exports: [PAYMENT_ORDER_QUERY],
})
export class OrdersPaymentQueryModule {}
