import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { jsonApiCollection, jsonApiResource } from '@edu-api/http';
import {
  COMMUNICATION_ADMIN_OPERATIONS,
  CommunicationDeliveryNotFoundError,
  CommunicationRetryConflictError,
  type CommunicationAdminOperations,
} from '@edu-api/communication';

import {
  ADMIN_OPERATIONS_QUERY,
  type AdminOperationsQuery,
} from '../application/admin-operations-query';
import {
  AdminSessionGuard,
  type AdminAuthenticatedRequest,
  adminSessionCookieName,
} from './admin-session.guard';

const orderStatuses = [
  'ALLOCATED',
  'COMPLETE',
  'DELIVERY_ISSUE',
  'PAID',
  'UNPAID',
  'WAITING',
] as const;
const deliveryStates = [
  'NEEDS_ATTENTION',
  'PENDING',
  'PROCESSING',
  'RETRYING',
  'SENT',
  'UNKNOWN',
] as const;

@Controller('admin/operations')
@ApiTags('Administration operations')
@ApiProduces('application/vnd.api+json')
@UseGuards(AdminSessionGuard)
@ApiCookieAuth(adminSessionCookieName)
export class AdminOperationsController {
  constructor(
    @Inject(ADMIN_OPERATIONS_QUERY)
    private readonly operations: AdminOperationsQuery,
    @Inject(COMMUNICATION_ADMIN_OPERATIONS)
    private readonly communication: CommunicationAdminOperations,
  ) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Read bounded sales and operational totals' })
  @ApiOkResponse({ description: 'Sales, stock, backlog, and delivery totals.' })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  async dashboard(@Query('from') from: unknown, @Query('to') to: unknown) {
    const window = dateWindow(from, to);
    return jsonApiResource(
      'operations-dashboard',
      `${window.from.toISOString()}_${window.to.toISOString()}`,
      await this.operations.getDashboard(window),
    );
  }

  @Get('orders')
  @ApiOperation({ summary: 'Search and paginate guest voucher orders' })
  @ApiOkResponse({ description: 'A bounded page of order summaries.' })
  @ApiQuery({ name: 'query', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: orderStatuses })
  @ApiQuery({ name: 'channel', required: false, enum: ['WEB', 'USSD'] })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async orders(
    @Query('query') query: unknown,
    @Query('status') status: unknown,
    @Query('channel') channel: unknown,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
  ) {
    const page = await this.operations.listOrders({
      limit: pageLimit(limit),
      ...(optionalString(cursor, 'cursor') === undefined
        ? {}
        : { cursor: optionalString(cursor, 'cursor') }),
      ...(optionalBoundedString(query, 'query', 320) === undefined
        ? {}
        : { query: optionalBoundedString(query, 'query', 320) }),
      ...(optionalEnum(status, orderStatuses, 'status') === undefined
        ? {}
        : { status: optionalEnum(status, orderStatuses, 'status') }),
      ...(optionalEnum(channel, ['WEB', 'USSD'] as const, 'channel') ===
      undefined
        ? {}
        : {
            channel: optionalEnum(channel, ['WEB', 'USSD'] as const, 'channel'),
          }),
      ...(from === undefined ? {} : { from: requiredDate(from, 'from') }),
      ...(to === undefined ? {} : { to: requiredDate(to, 'to') }),
    });
    return collection('orders', page);
  }

  @Get('orders/:orderPublicReference')
  @ApiOperation({ summary: 'Read a complete protected order lifecycle' })
  @ApiParam({ name: 'orderPublicReference', format: 'uuid' })
  async order(@Param('orderPublicReference') orderPublicReference: string) {
    const result = await this.operations.getOrder(
      requiredUuid(orderPublicReference, 'orderPublicReference'),
    );
    if (result === null) {
      throw new NotFoundException({
        code: 'ADMIN_ORDER_NOT_FOUND',
        message: 'The order was not found.',
      });
    }
    return jsonApiResource('orders', result.id, result.attributes);
  }

  @Get('inventory')
  @ApiOperation({ summary: 'Monitor product inventory and paid demand' })
  async inventory(
    @Query('query') query: unknown,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ) {
    const page = await this.operations.listInventory({
      limit: pageLimit(limit),
      ...(optionalString(cursor, 'cursor') === undefined
        ? {}
        : { cursor: optionalString(cursor, 'cursor') }),
      ...(optionalBoundedString(query, 'query', 120) === undefined
        ? {}
        : { query: optionalBoundedString(query, 'query', 120) }),
    });
    return collection('inventory-products', page);
  }

  @Get('backlog')
  @ApiOperation({ summary: 'Monitor paid voucher obligations awaiting stock' })
  async backlog(
    @Query('productPublicId') productPublicId: unknown,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ) {
    const product = optionalString(productPublicId, 'productPublicId');
    const page = await this.operations.listBacklog({
      limit: pageLimit(limit),
      ...(optionalString(cursor, 'cursor') === undefined
        ? {}
        : { cursor: optionalString(cursor, 'cursor') }),
      ...(product === undefined
        ? {}
        : { productPublicId: requiredUuid(product, 'productPublicId') }),
    });
    return collection('paid-backlog-units', page);
  }

  @Get('vouchers')
  @ApiOperation({
    summary: 'Search voucher inventory without exposing voucher PINs',
  })
  async vouchers(
    @Query('productPublicId') productPublicId: unknown,
    @Query('serialNumber') serialNumber: unknown,
    @Query('status') status: unknown,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ) {
    const product = optionalString(productPublicId, 'productPublicId');
    const page = await this.operations.listVouchers({
      limit: pageLimit(limit),
      ...(optionalString(cursor, 'cursor') === undefined
        ? {}
        : { cursor: optionalString(cursor, 'cursor') }),
      ...(product === undefined
        ? {}
        : { productPublicId: requiredUuid(product, 'productPublicId') }),
      ...(optionalBoundedString(serialNumber, 'serialNumber', 256) === undefined
        ? {}
        : {
            serialNumber: optionalBoundedString(
              serialNumber,
              'serialNumber',
              256,
            ),
          }),
      ...(optionalEnum(status, ['AVAILABLE', 'SOLD'] as const, 'status') ===
      undefined
        ? {}
        : {
            status: optionalEnum(
              status,
              ['AVAILABLE', 'SOLD'] as const,
              'status',
            ),
          }),
    });
    return collection('vouchers', page);
  }

  @Get('deliveries')
  @ApiOperation({ summary: 'Monitor voucher delivery state and attempts' })
  async deliveries(
    @Query('state') state: unknown,
    @Query('channel') channel: unknown,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ) {
    const page = await this.operations.listDeliveries({
      limit: pageLimit(limit),
      ...(optionalString(cursor, 'cursor') === undefined
        ? {}
        : { cursor: optionalString(cursor, 'cursor') }),
      ...(optionalEnum(state, deliveryStates, 'state') === undefined
        ? {}
        : { state: optionalEnum(state, deliveryStates, 'state') }),
      ...(optionalEnum(channel, ['SMS', 'EMAIL'] as const, 'channel') ===
      undefined
        ? {}
        : {
            channel: optionalEnum(
              channel,
              ['SMS', 'EMAIL'] as const,
              'channel',
            ),
          }),
    });
    return collection('communication-deliveries', page);
  }

  @Post('deliveries/:deliveryPublicId/retry')
  @ApiOperation({
    summary: 'Safely retry a non-ambiguous failed voucher delivery',
  })
  @ApiParam({ name: 'deliveryPublicId', format: 'uuid' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', minLength: 16, maxLength: 128 },
  })
  async retryDelivery(
    @Param('deliveryPublicId') deliveryPublicId: string,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    try {
      const result = await this.communication.requestRetry({
        actorAdminUserId: requiredAdmin(request).id,
        correlationId: request.id,
        deliveryPublicId: requiredUuid(deliveryPublicId, 'deliveryPublicId'),
        idempotencyKey: requiredIdempotencyKey(idempotencyKey),
      });
      return jsonApiResource(
        'communication-deliveries',
        result.deliveryPublicId,
        { retryScheduled: result.changed },
      );
    } catch (error) {
      if (error instanceof CommunicationDeliveryNotFoundError) {
        throw new NotFoundException({
          code: 'COMMUNICATION_DELIVERY_NOT_FOUND',
          message: error.message,
        });
      }
      if (error instanceof CommunicationRetryConflictError) {
        throw new ConflictException({
          code: 'COMMUNICATION_RETRY_CONFLICT',
          message: error.message,
        });
      }
      throw error;
    }
  }

  @Get('audit-events')
  @ApiOperation({ summary: 'Read immutable administration audit events' })
  async auditEvents(
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ) {
    const page = await this.operations.listAuditEvents({
      limit: pageLimit(limit),
      ...(optionalString(cursor, 'cursor') === undefined
        ? {}
        : { cursor: optionalString(cursor, 'cursor') }),
    });
    return collection('admin-audit-events', page);
  }

  @Get('reconciliation-findings')
  @ApiOperation({ summary: 'Read persisted reconciliation mismatches' })
  async reconciliationFindings(
    @Query('status') status: unknown,
    @Query('type') type: unknown,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ) {
    const page = await this.operations.listReconciliationFindings({
      limit: pageLimit(limit),
      ...(optionalString(cursor, 'cursor') === undefined
        ? {}
        : {
            cursor: requiredUuid(optionalString(cursor, 'cursor')!, 'cursor'),
          }),
      ...(optionalEnum(status, ['OPEN', 'RESOLVED'] as const, 'status') ===
      undefined
        ? {}
        : {
            status: optionalEnum(
              status,
              ['OPEN', 'RESOLVED'] as const,
              'status',
            ),
          }),
      ...(optionalBoundedString(type, 'type', 120) === undefined
        ? {}
        : { type: optionalBoundedString(type, 'type', 120) }),
    });
    return collection('reconciliation-findings', page);
  }
}

function collection(
  type: string,
  page: Awaited<ReturnType<AdminOperationsQuery['listOrders']>>,
) {
  return jsonApiCollection(
    type,
    page.items.map((item) => ({ id: item.id, attributes: item.attributes })),
    { nextCursor: page.nextCursor },
  );
}

function pageLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value)) invalid('limit');
  const parsed = Number(value);
  if (parsed < 1 || parsed > 100) invalid('limit');
  return parsed;
}

function optionalString(value: unknown, field: string): string | undefined {
  return optionalBoundedString(value, field, 2_048);
}

function optionalBoundedString(
  value: unknown,
  field: string,
  maximum: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalid(field);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) invalid(field);
  return normalized;
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string,
): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value)) invalid(field);
  return value as T[number];
}

function dateWindow(from: unknown, to: unknown) {
  const end = to === undefined ? new Date() : requiredDate(to, 'to');
  const start =
    from === undefined
      ? new Date(end.getTime() - 24 * 60 * 60 * 1_000)
      : requiredDate(from, 'from');
  if (
    start >= end ||
    end.getTime() - start.getTime() > 366 * 24 * 60 * 60 * 1_000
  ) {
    invalid('date window');
  }
  return { from: start, to: end };
}

function requiredDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' || value.length > 64) invalid(field);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) invalid(field);
  return date;
}

function requiredUuid(value: string, field: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    invalid(field);
  }
  return value;
}

function requiredIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(value)) {
    invalid('Idempotency-Key');
  }
  return value;
}

function requiredAdmin(request: AdminAuthenticatedRequest) {
  if (request.admin === undefined) {
    throw new BadRequestException({
      code: 'ADMIN_AUTHENTICATION_REQUIRED',
      message: 'Administrator authentication is required.',
    });
  }
  return request.admin;
}

function invalid(field: string): never {
  throw new BadRequestException({
    code: 'ADMIN_OPERATIONS_QUERY_INVALID',
    message: `${field} is invalid.`,
  });
}
