import {
  ArgumentsHost,
  CallHandler,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Observable, catchError, map, throwError } from 'rxjs';

import { StructuredLogger } from '@edu-api/observability';

interface ApiError {
  readonly code: string;
  readonly detail: string;
  readonly status: string;
  readonly title: string;
  readonly meta: { readonly correlationId: string; readonly timestamp: string };
}

export interface JsonApiResource<TAttributes extends Record<string, unknown>> {
  readonly attributes: TAttributes;
  readonly id: string;
  readonly type: string;
}

export interface JsonApiDocument<TAttributes extends Record<string, unknown>> {
  readonly data: JsonApiResource<TAttributes>;
  readonly meta?: Record<string, unknown>;
}

export interface JsonApiCollectionDocument<
  TAttributes extends Record<string, unknown>,
> {
  readonly data: readonly JsonApiResource<TAttributes>[];
  readonly meta?: Record<string, unknown>;
}

export function jsonApiResource<TAttributes extends Record<string, unknown>>(
  type: string,
  id: string,
  attributes: TAttributes,
): JsonApiDocument<TAttributes> {
  return { data: { type, id, attributes } };
}

export function jsonApiCollection<TAttributes extends Record<string, unknown>>(
  type: string,
  resources: readonly Omit<JsonApiResource<TAttributes>, 'type'>[],
  meta?: Record<string, unknown>,
): JsonApiCollectionDocument<TAttributes> {
  return {
    data: resources.map((resource) => ({ ...resource, type })),
    ...(meta === undefined ? {} : { meta }),
  };
}

@Injectable()
class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<FastifyReply>();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    response
      .header('x-correlation-id', request.id)
      .type('application/vnd.api+json');

    return next.handle().pipe(
      map(
        (document: {
          readonly data: unknown;
          readonly meta?: Record<string, unknown>;
        }) => ({
          ...document,
          meta: { ...document.meta, correlationId: request.id },
        }),
      ),
    );
  }
}

@Injectable()
class RequestLoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: StructuredLogger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = performance.now();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const response = context.switchToHttp().getResponse<FastifyReply>();

    return next.handle().pipe(
      map((value: unknown) => {
        this.logger.request({
          correlationId: request.id,
          durationMs: Math.round(performance.now() - startedAt),
          method: request.method,
          route: request.routeOptions.url ?? request.url,
          statusCode: response.statusCode,
        });
        return value;
      }),
      catchError((error: unknown) => {
        this.logger.request({
          correlationId: request.id,
          durationMs: Math.round(performance.now() - startedAt),
          method: request.method,
          route: request.routeOptions.url ?? request.url,
          statusCode:
            error instanceof HttpException
              ? error.getStatus()
              : HttpStatus.INTERNAL_SERVER_ERROR,
        });

        return throwError(() => error);
      }),
    );
  }
}

@Catch()
class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const detail =
      exception instanceof HttpException
        ? this.detail(exception)
        : 'An unexpected error occurred.';
    const error: ApiError = {
      status: String(status),
      code:
        exception instanceof HttpException
          ? this.code(exception)
          : 'INTERNAL_ERROR',
      title: HttpStatus[status] ?? 'Internal Server Error',
      detail,
      meta: { correlationId: request.id, timestamp: new Date().toISOString() },
    };
    response
      .header('x-correlation-id', request.id)
      .type('application/vnd.api+json')
      .status(status)
      .send({ errors: [error] });
  }

  private code(exception: HttpException): string {
    const body = exception.getResponse();
    return typeof body === 'object' &&
      body !== null &&
      'code' in body &&
      typeof body.code === 'string'
      ? body.code
      : 'HTTP_ERROR';
  }

  private detail(exception: HttpException): string {
    const body = exception.getResponse();
    return typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof body.message === 'string'
      ? body.message
      : exception.message;
  }
}

export function configureHttpFoundation(
  app: INestApplication,
  logger: StructuredLogger,
): void {
  app.useLogger(logger);
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(
    new RequestLoggingInterceptor(logger),
    new ResponseEnvelopeInterceptor(),
  );
}

export function configureApiSecurity(
  app: INestApplication,
  options: {
    readonly allowedOrigins: readonly string[];
    readonly credentials: boolean;
    readonly production: boolean;
  },
): void {
  app.enableCors({
    origin: [...options.allowedOrigins],
    credentials: options.credentials,
    allowedHeaders: ['Content-Type', 'Idempotency-Key'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 24 * 60 * 60,
  });
  const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;
  fastify.addHook('onSend', (_request, reply, payload, done) => {
    reply
      .header('cache-control', 'no-store')
      .header('cross-origin-opener-policy', 'same-origin')
      .header('cross-origin-resource-policy', 'same-site')
      .header('permissions-policy', 'camera=(), geolocation=(), microphone=()')
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY');
    if (options.production) {
      reply.header(
        'strict-transport-security',
        'max-age=31536000; includeSubDomains',
      );
    }
    done(null, payload);
  });
}

export function configureOpenApi(
  app: INestApplication,
  serviceName: string,
): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(`${serviceName} API`)
      .setDescription('Operational API contract for this service.')
      .setVersion('1.0.0')
      .build(),
  );

  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'openapi.json',
    raw: ['json'],
    // The machine-readable contract remains available in every environment.
    // Interactive docs are a local/staging convenience, not a production UI.
    ui: process.env.NODE_ENV !== 'production',
    useGlobalPrefix: true,
  });
}
