import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';

import { corsAllowedOrigins, trustProxyFromEnvironment } from '@edu-api/config';
import {
  configureApiSecurity,
  configureHttpFoundation,
  configureOpenApi,
} from '@edu-api/http';
import { StructuredLogger } from '@edu-api/observability';

import { PublicApiModule } from './public-api.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    PublicApiModule,
    new FastifyAdapter({
      bodyLimit: 256 * 1024,
      genReqId: () => randomUUID(),
      trustProxy: trustProxyFromEnvironment(),
    }),
    { rawBody: true },
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
  configureApiSecurity(app, {
    allowedOrigins: corsAllowedOrigins(
      config.get<string>('CORS_ALLOWED_ORIGINS'),
      new URL(config.getOrThrow<string>('PAYSTACK_CALLBACK_URL')).origin,
    ),
    credentials: false,
    production: config.getOrThrow<string>('NODE_ENV') === 'production',
  });
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
