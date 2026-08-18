import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { jsonApiResource } from '@edu-api/http';

import {
  PaymentIdempotencyConflictError,
  PaymentInitializationInProgressError,
  PaymentInputValidationError,
  PaymentOrderAlreadyPaidError,
  PaymentOrderUnavailableError,
  PaymentProcessingUnavailableError,
  PaymentProviderRejectedError,
  PaymentProviderUnknownOutcomeError,
  PaymentRateLimitExceededError,
} from '../application/payment-errors';
import {
  PAYMENT_INITIALIZATION_SERVICE,
  type PaymentInitializationService,
} from '../application/payment-initialization-service';
import { assertEmptyPaymentInitializationBody } from '../domain/payment-validation';

@Controller()
@ApiTags('Payments')
@ApiProduces('application/vnd.api+json')
export class PublicPaymentsController {
  constructor(
    @Inject(PAYMENT_INITIALIZATION_SERVICE)
    private readonly payments: PaymentInitializationService,
  ) {}

  @Post('orders/:orderPublicReference/payments')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Initialize an idempotent Paystack web payment' })
  @ApiParam({ name: 'orderPublicReference', format: 'uuid' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique key for one intentional payment attempt.',
  })
  @ApiBody({
    required: false,
    schema: { type: 'object', additionalProperties: false, maxProperties: 0 },
  })
  @ApiCreatedResponse({ description: 'The new or replayed checkout attempt.' })
  @ApiBadRequestResponse({ description: 'The request contract is invalid.' })
  @ApiConflictResponse({
    description:
      'The key conflicts, initialization is active, or order is paid.',
  })
  @ApiBadGatewayResponse({ description: 'Paystack rejected initialization.' })
  @ApiTooManyRequestsResponse({
    description: 'The payment rate limit was hit.',
  })
  async initializePayment(
    @Param('orderPublicReference') orderPublicReference: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    try {
      if (idempotencyKey === undefined) {
        throw new PaymentInputValidationError('Idempotency-Key is required.');
      }
      assertEmptyPaymentInitializationBody(body);
      const payment = await this.payments.initialize({
        clientIp: request.ip,
        idempotencyKey,
        orderPublicReference,
      });
      return jsonApiResource(
        'payment-attempts',
        payment.paymentPublicReference,
        {
          accessCode: payment.accessCode,
          amountMinor: payment.amountMinor,
          authorizationUrl: payment.authorizationUrl,
          currency: payment.currency,
          provider: payment.provider,
          providerReference: payment.providerReference,
          status: payment.status,
        },
      );
    } catch (error) {
      if (error instanceof PaymentInputValidationError) {
        throw new BadRequestException({
          code: 'INVALID_PAYMENT_REQUEST',
          message: error.message,
        });
      }
      if (error instanceof PaymentIdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_CONFLICT',
          message: error.message,
        });
      }
      if (error instanceof PaymentOrderUnavailableError) {
        throw new ConflictException({
          code: 'PAYMENT_ORDER_UNAVAILABLE',
          message: error.message,
        });
      }
      if (error instanceof PaymentOrderAlreadyPaidError) {
        throw new ConflictException({
          code: 'ORDER_ALREADY_PAID',
          message: error.message,
        });
      }
      if (error instanceof PaymentInitializationInProgressError) {
        response.header('retry-after', '2');
        throw new ConflictException({
          code: 'PAYMENT_INITIALIZATION_IN_PROGRESS',
          message: error.message,
        });
      }
      if (error instanceof PaymentRateLimitExceededError) {
        response.header('retry-after', String(error.retryAfterSeconds));
        throw new HttpException(
          { code: 'PAYMENT_RATE_LIMITED', message: error.message },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (error instanceof PaymentProviderRejectedError) {
        throw new BadGatewayException({
          code: 'PAYMENT_PROVIDER_REJECTED',
          message: error.message,
        });
      }
      if (
        error instanceof PaymentProviderUnknownOutcomeError ||
        error instanceof PaymentProcessingUnavailableError
      ) {
        throw new ServiceUnavailableException({
          code: 'PAYMENT_TEMPORARILY_UNAVAILABLE',
          message: error.message,
        });
      }
      throw error;
    }
  }
}
