import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';

import { trustProxyFromEnvironment } from '@edu-api/config';
import { configureHttpFoundation, configureOpenApi } from '@edu-api/http';
import { StructuredLogger } from '@edu-api/observability';

import { AdminApiModule } from './admin-api.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AdminApiModule,
    new FastifyAdapter({
      // CSV is hard-limited again by the inventory import parser. This limit
      // lets Fastify accept the configured administrative import maximum.
      bodyLimit: 64 * 1024 * 1024,
      genReqId: () => randomUUID(),
      trustProxy: trustProxyFromEnvironment(),
    }),
  );

  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser('text/csv', (_request, payload, done) =>
      done(null, payload),
    );

  const config = app.get(ConfigService);
  const host = config.getOrThrow<string>('HOST');
  const port = config.getOrThrow<number>('PORT');
  const serviceName = config.getOrThrow<string>('SERVICE_NAME');
  const logger = new StructuredLogger({
    environment: config.getOrThrow<string>('NODE_ENV'),
    level: config.getOrThrow<
      'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose'
    >('LOG_LEVEL'),
    service: serviceName,
  });
  const globalPrefix = 'v1';

  app.setGlobalPrefix(globalPrefix);
  configureOpenApi(app, serviceName);
  configureHttpFoundation(app, logger);
  app.enableShutdownHooks();

  await app.listen({
    host,
    port,
  });

  Logger.log(
    `${serviceName} running at http://localhost:${port}/${globalPrefix}`,
    'Bootstrap',
  );
}

void bootstrap();
