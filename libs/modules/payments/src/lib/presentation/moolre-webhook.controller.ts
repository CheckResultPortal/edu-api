import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  RawBody,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';

import { jsonApiResource } from '@edu-api/http';

import { PaymentProcessingUnavailableError } from '../application/payment-errors';
import { PaymentProviderRequestError } from '../application/payment-provider';
import {
  MOOLRE_WEBHOOK_SERVICE,
  type MoolreWebhookService,
} from '../application/moolre-webhook-service';

@Controller('payments/moolre')
@ApiTags('Payment provider callbacks')
@ApiProduces('application/vnd.api+json')
export class MoolreWebhookController {
  constructor(
    @Inject(MOOLRE_WEBHOOK_SERVICE)
    private readonly webhooks: MoolreWebhookService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive a Moolre collection notification' })
  @ApiOkResponse({ description: 'The notification was acknowledged.' })
  @ApiBadRequestResponse({ description: 'The payload is malformed.' })
  async handleWebhook(@RawBody() rawBody: Buffer | undefined) {
    try {
      if (rawBody === undefined) {
        return jsonApiResource('payment-webhook-receipts', 'moolre', {
          outcome: 'IGNORED',
        });
      }
      const outcome = await this.webhooks.handle(rawBody, undefined);
      return jsonApiResource('payment-webhook-receipts', 'moolre', {
        outcome,
      });
    } catch (error) {
      // Verification against the status endpoint is idempotent, so any
      // transient failure is safe for Moolre to redeliver.
      if (
        error instanceof PaymentProcessingUnavailableError ||
        error instanceof PaymentProviderRequestError
      ) {
        throw new ServiceUnavailableException({
          code: 'PAYMENT_WEBHOOK_TEMPORARILY_UNAVAILABLE',
          message: 'The payment notification could not be verified yet.',
        });
      }
      throw error;
    }
  }
}
