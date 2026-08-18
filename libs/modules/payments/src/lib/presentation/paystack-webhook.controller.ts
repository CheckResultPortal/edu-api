import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  RawBody,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { jsonApiResource } from '@edu-api/http';

import {
  PaymentProcessingUnavailableError,
  PaymentWebhookAuthenticationError,
  PaymentWebhookPayloadError,
} from '../application/payment-errors';
import {
  PAYMENT_WEBHOOK_SERVICE,
  type PaymentWebhookService,
} from '../application/payment-success-service';

@Controller('payments/paystack')
@ApiTags('Payment provider callbacks')
@ApiProduces('application/vnd.api+json')
export class PaystackWebhookController {
  constructor(
    @Inject(PAYMENT_WEBHOOK_SERVICE)
    private readonly webhooks: PaymentWebhookService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive an authenticated Paystack webhook' })
  @ApiHeader({ name: 'x-paystack-signature', required: true })
  @ApiOkResponse({ description: 'The authenticated event was acknowledged.' })
  @ApiUnauthorizedResponse({ description: 'The signature is invalid.' })
  @ApiBadRequestResponse({ description: 'The signed payload is malformed.' })
  async handleWebhook(
    @RawBody() rawBody: Buffer | undefined,
    @Headers('x-paystack-signature') signature: string | undefined,
  ) {
    try {
      if (rawBody === undefined) throw new PaymentWebhookPayloadError();
      const outcome = await this.webhooks.handle(rawBody, signature);
      return jsonApiResource('payment-webhook-receipts', 'paystack', {
        outcome,
      });
    } catch (error) {
      if (error instanceof PaymentWebhookAuthenticationError) {
        throw new UnauthorizedException({
          code: 'INVALID_PAYMENT_WEBHOOK_SIGNATURE',
          message: error.message,
        });
      }
      if (error instanceof PaymentWebhookPayloadError) {
        throw new BadRequestException({
          code: 'INVALID_PAYMENT_WEBHOOK',
          message: error.message,
        });
      }
      if (error instanceof PaymentProcessingUnavailableError) {
        throw new ServiceUnavailableException({
          code: 'PAYMENT_WEBHOOK_TEMPORARILY_UNAVAILABLE',
          message: error.message,
        });
      }
      throw error;
    }
  }
}
