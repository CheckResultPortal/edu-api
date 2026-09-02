import {
  BadRequestException,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  Body,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  CUSTOMER_VOUCHER_RETRIEVAL,
  CustomerVoucherRetrievalConflictError,
  type CustomerVoucherRetrieval,
} from '@edu-api/communication';
import { jsonApiCollection, jsonApiResource } from '@edu-api/http';

import {
  OrderCreationUnavailableError,
  OrderCurrencyUnsupportedError,
  OrderIdempotencyConflictError,
  OrderInputValidationError,
  OrderProductUnavailableError,
  OrderRateLimitExceededError,
} from '../application/order-creation-errors';
import {
  GUEST_ORDER_STATUS_QUERY,
  GUEST_ORDER_STATUS_RATE_LIMITER,
  type GuestOrderStatusQuery,
} from '../application/guest-order-status-query';
import {
  ORDER_CREATION_SERVICE,
  type OrderCreationService,
  type OrderRateLimiter,
} from '../application/order-creation-service';
import {
  assertOrderIdempotencyKey,
  normalizeOrderPublicReference,
  parseGuestOrderRequest,
  parseGuestOrderStatusRequest,
  parseGuestVoucherRetrievalRequest,
} from '../domain/order-validation';

@Controller('orders')
@ApiTags('Orders')
@ApiProduces('application/vnd.api+json')
export class PublicOrdersController {
  constructor(
    @Inject(ORDER_CREATION_SERVICE)
    private readonly orders: OrderCreationService,
    @Inject(GUEST_ORDER_STATUS_QUERY)
    private readonly statusQuery: GuestOrderStatusQuery,
    @Inject(GUEST_ORDER_STATUS_RATE_LIMITER)
    private readonly statusRateLimiter: OrderRateLimiter,
    @Inject(CUSTOMER_VOUCHER_RETRIEVAL)
    private readonly voucherRetrieval: CustomerVoucherRetrieval,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an idempotent guest voucher order' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique key for one intentional checkout attempt.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'email',
        'firstName',
        'phoneNumber',
        'productPublicId',
        'quantity',
      ],
      properties: {
        email: {
          type: 'string',
          maxLength: 320,
          description:
            'Customer email address for payment initialization and voucher delivery.',
        },
        firstName: { type: 'string', minLength: 1, maxLength: 100 },
        phoneNumber: { type: 'string', example: '+233241234567' },
        productPublicId: { type: 'string', format: 'uuid' },
        quantity: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
  })
  @ApiCreatedResponse({ description: 'The new or previously created order.' })
  @ApiBadRequestResponse({ description: 'The request contract is invalid.' })
  @ApiConflictResponse({
    description: 'The product is unavailable or the key conflicts.',
  })
  @ApiTooManyRequestsResponse({ description: 'The order rate limit was hit.' })
  async createOrder(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    try {
      if (idempotencyKey === undefined) {
        throw new OrderInputValidationError('Idempotency-Key is required.');
      }
      const input = parseGuestOrderRequest(body);
      const order = await this.orders.create(
        {
          email: input.email,
          firstName: input.firstName,
          idempotencyKey,
          phoneNumber: input.phoneNumber,
          productPublicId: input.productPublicId,
          quantity: input.quantity,
        },
        { clientIp: request.ip },
      );
      return jsonApiResource('orders', order.publicReference, {
        currency: order.currency,
        deliveryPreference: order.deliveryPreference,
        productPublicId: order.productPublicId,
        purchaseChannel: order.purchaseChannel,
        quantity: order.quantity,
        totalPriceMinor: order.totalPriceMinor,
        unitPriceMinor: order.unitPriceMinor,
      });
    } catch (error) {
      throw this.mapOrderCreationError(error, response);
    }
  }

  @Post('status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Look up guest order status by phone and email or reference',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['phoneNumber'],
      properties: {
        phoneNumber: { type: 'string', example: '+233241234567' },
        email: { type: 'string', maxLength: 320 },
        orderReference: { type: 'string', format: 'uuid' },
      },
    },
  })
  @ApiOkResponse({ description: 'Matching orders with lifecycle status.' })
  @ApiBadRequestResponse({ description: 'The request contract is invalid.' })
  @ApiTooManyRequestsResponse({ description: 'The status rate limit was hit.' })
  async lookupOrderStatus(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    try {
      const input = parseGuestOrderStatusRequest(body);
      await this.statusRateLimiter.consume({
        clientIp: request.ip,
        phoneNumber: input.phoneNumber,
      });
      const orders =
        input.email === undefined
          ? await this.findOrderByReference(
              input.phoneNumber,
              input.orderReference!,
            )
          : await this.statusQuery.findByPhoneAndEmail(
              input.phoneNumber,
              input.email,
            );
      return jsonApiCollection(
        'order-statuses',
        orders.map((order) => ({
          id: order.publicReference,
          attributes: {
            canRequestVoucherEmail: order.canRequestVoucherEmail,
            createdAt: order.createdAt.toISOString(),
            currency: order.currency,
            productName: order.productName,
            quantity: order.quantity,
            status: order.status,
            totalPriceMinor: order.totalPriceMinor,
          },
        })),
      );
    } catch (error) {
      throw this.mapGuestLookupError(error, response, 'INVALID_STATUS_REQUEST');
    }
  }

  @Post(':orderReference/voucher-retrieval')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Queue a copy of fully fulfilled vouchers to the order email',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique key for one intentional voucher-copy request.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        email: { type: 'string', maxLength: 320 },
        phoneNumber: { type: 'string', example: '+233241234567' },
      },
      minProperties: 1,
    },
  })
  @ApiAcceptedResponse({
    description: 'A copy has been queued for the order email address.',
  })
  @ApiBadRequestResponse({ description: 'The request contract is invalid.' })
  @ApiConflictResponse({ description: 'The request key conflicts.' })
  @ApiTooManyRequestsResponse({ description: 'The status rate limit was hit.' })
  async requestVoucherCopy(
    @Param('orderReference') rawOrderReference: string,
    @Body() body: unknown,
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    try {
      if (rawIdempotencyKey === undefined) {
        throw new OrderInputValidationError('Idempotency-Key is required.');
      }
      const idempotencyKey = assertOrderIdempotencyKey(rawIdempotencyKey);
      const orderReference = normalizeOrderPublicReference(rawOrderReference);
      const contact = parseGuestVoucherRetrievalRequest(body);
      await this.statusRateLimiter.consume({
        clientIp: request.ip,
        phoneNumber: contact.phoneNumber ?? `email:${contact.email!}`,
      });
      const access = await this.statusQuery.findVoucherRetrievalAccess({
        ...contact,
        orderReference,
      });
      if (access === null) {
        throw new NotFoundException({
          code: 'ORDER_NOT_FOUND',
          message: 'The order could not be found with those details.',
        });
      }
      const delivery = await this.voucherRetrieval.request({
        destinationEmail: access.destinationEmail,
        idempotencyKey,
        orderId: access.orderId,
      });
      return jsonApiResource('voucher-retrievals', delivery.deliveryPublicId, {
        status: 'QUEUED',
      });
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      if (error instanceof CustomerVoucherRetrievalConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_CONFLICT',
          message: error.message,
        });
      }
      throw this.mapGuestLookupError(
        error,
        response,
        'INVALID_VOUCHER_RETRIEVAL_REQUEST',
      );
    }
  }

  private async findOrderByReference(
    phoneNumber: string,
    orderReference: string,
  ) {
    const order = await this.statusQuery.findByPhoneAndReference(
      phoneNumber,
      orderReference,
    );
    return order === null ? [] : [order];
  }

  private mapOrderCreationError(
    error: unknown,
    response: FastifyReply,
  ): HttpException {
    if (error instanceof OrderInputValidationError) {
      return new BadRequestException({
        code: 'INVALID_ORDER_REQUEST',
        message: error.message,
      });
    }
    if (error instanceof OrderIdempotencyConflictError) {
      return new ConflictException({
        code: 'IDEMPOTENCY_CONFLICT',
        message: error.message,
      });
    }
    if (
      error instanceof OrderProductUnavailableError ||
      error instanceof OrderCurrencyUnsupportedError
    ) {
      return new ConflictException({
        code: 'PRODUCT_UNAVAILABLE',
        message: error.message,
      });
    }
    if (error instanceof OrderRateLimitExceededError) {
      response.header('retry-after', String(error.retryAfterSeconds));
      return new HttpException(
        { code: 'ORDER_RATE_LIMITED', message: error.message },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (error instanceof OrderCreationUnavailableError) {
      return new ServiceUnavailableException({
        code: 'ORDER_CREATION_UNAVAILABLE',
        message: error.message,
      });
    }
    throw error;
  }

  private mapGuestLookupError(
    error: unknown,
    response: FastifyReply,
    validationCode: string,
  ): HttpException {
    if (error instanceof OrderInputValidationError) {
      return new BadRequestException({
        code: validationCode,
        message: error.message,
      });
    }
    if (error instanceof OrderRateLimitExceededError) {
      response.header('retry-after', String(error.retryAfterSeconds));
      return new HttpException(
        { code: 'ORDER_STATUS_RATE_LIMITED', message: error.message },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    throw error;
  }
}
