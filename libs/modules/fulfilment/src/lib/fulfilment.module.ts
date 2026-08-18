import { Module } from '@nestjs/common';

import { TRANSACTIONAL_FULFILMENT_UNIT_WRITER } from './application/transactional-fulfilment-unit-writer';
import { PrismaTransactionalFulfilmentUnitWriter } from './infrastructure/prisma-transactional-fulfilment-unit-writer';

@Module({
  providers: [
    {
      provide: TRANSACTIONAL_FULFILMENT_UNIT_WRITER,
      useClass: PrismaTransactionalFulfilmentUnitWriter,
    },
  ],
  exports: [TRANSACTIONAL_FULFILMENT_UNIT_WRITER],
})
export class FulfilmentCoreModule {}
