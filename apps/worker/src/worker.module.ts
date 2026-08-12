import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateWorkerEnvironment } from '@edu-api/config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['apps/worker/.env.local', 'apps/worker/.env', '.env'],
      validate: validateWorkerEnvironment,
    }),
  ],
})
export class WorkerModule {}
