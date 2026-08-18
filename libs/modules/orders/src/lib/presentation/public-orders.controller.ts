import {
  BadRequestException,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  Body,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { jsonApiResource } from '@edu-api/http';

import {
  OrderCreationUnavailableError,
  OrderCurrencyUnsupportedError,
  OrderIdempotencyConflictError,
  OrderInputValidationError,
  OrderProductUnavailableError,
  OrderRateLimitExceededError,
} from '../application/order-creation-errors';
import {
  ORDER_CREATION_SERVICE,
  type OrderCreationService,
} from '../application/order-creation-service';
import { parseGuestOrderRequest } from '../domain/order-validation';

@Controller('orders')
@ApiTags('Orders')
@ApiProduces('application/vnd.api+json')
export class PublicOrdersController {
  constructor(
    @Inject(ORDER_CREATION_SERVICE)
    private readonly orders: OrderCreationService,
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
        'deliveryPreference',
        'firstName',
        'phoneNumber',
        'productPublicId',
        'quantity',
      ],
      properties: {
        deliveryPreference: {
          type: 'string',
          enum: ['SMS_ONLY', 'SMS_AND_EMAIL'],
          description:
            'SMS is always used. SMS_AND_EMAIL also requires an email address.',
        },
        email: {
          type: 'string',
          maxLength: 320,
          description: 'Required only for SMS_AND_EMAIL; omit for SMS_ONLY.',
        },
        firstName: { type: 'string', minLength: 1, maxLength: 100 },
        phoneNumber: { type: 'string', example: '+233241234567' },
        productPublicId: { type: 'string', format: 'uuid' },
        quantity: { type: 'integer', minimum: 1, maximum: 20 },
      },
      oneOf: [
        {
          properties: {
            deliveryPreference: { type: 'string', enum: ['SMS_ONLY'] },
          },
          not: { required: ['email'] },
        },
        {
          properties: {
            deliveryPreference: {
              type: 'string',
              enum: ['SMS_AND_EMAIL'],
            },
          },
          required: ['email'],
        },
      ],
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
          deliveryPreference: input.deliveryPreference,
          firstName: input.firstName,
          phoneNumber: input.phoneNumber,
          productPublicId: input.productPublicId,
          quantity: input.quantity,
          ...(input.email === null ? {} : { email: input.email }),
          idempotencyKey,
        },
        { clientIp: request.ip },
      );
      return jsonApiResource('orders', order.publicReference, {
        currency: order.currency,
        deliveryPreference: order.deliveryPreference,
        productPublicId: order.productPublicId,
        quantity: order.quantity,
        totalPriceMinor: order.totalPriceMinor,
        unitPriceMinor: order.unitPriceMinor,
      });
    } catch (error) {
      if (error instanceof OrderInputValidationError) {
        throw new BadRequestException({
          code: 'INVALID_ORDER_REQUEST',
          message: error.message,
        });
      }
      if (error instanceof OrderIdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_CONFLICT',
          message: error.message,
        });
      }
      if (
        error instanceof OrderProductUnavailableError ||
        error instanceof OrderCurrencyUnsupportedError
      ) {
        throw new ConflictException({
          code: 'PRODUCT_UNAVAILABLE',
          message: error.message,
        });
      }
      if (error instanceof OrderRateLimitExceededError) {
        response.header('retry-after', String(error.retryAfterSeconds));
        throw new HttpException(
          { code: 'ORDER_RATE_LIMITED', message: error.message },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (error instanceof OrderCreationUnavailableError) {
        throw new ServiceUnavailableException({
          code: 'ORDER_CREATION_UNAVAILABLE',
          message: error.message,
        });
      }
      throw error;
    }
  }
}
