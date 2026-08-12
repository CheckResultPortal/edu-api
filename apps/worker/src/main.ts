import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { StructuredLogger } from '@edu-api/observability';

import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['log', 'error', 'warn'],
  });

  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const serviceName = config.getOrThrow<string>('SERVICE_NAME');
  const logger = new StructuredLogger({
    environment: config.getOrThrow<string>('NODE_ENV'),
    level: config.getOrThrow<
      'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose'
    >('LOG_LEVEL'),
    service: serviceName,
  });
  app.useLogger(logger);

  logger.log(`${serviceName} started`, 'Bootstrap');

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Received ${signal}. Stopping worker...`, 'Bootstrap');

    await app.close();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

void bootstrap();
