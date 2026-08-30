import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  RawBody,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { StructuredLogger } from '@edu-api/observability';

import {
  USSD_FLOW_SERVICE,
  type UssdFlowContext,
  type UssdFlowService,
} from '../application/ussd-flow-service';
import { UssdRequestError } from '../application/ussd-errors';
import type { UssdProvider } from '../application/ussd-provider';
import { USSD_PROVIDER } from '../application/ussd-provider';
import {
  NALO_GATEWAY_ACCESS_POLICY,
  type NaloGatewayAccessPolicy,
} from '../infrastructure/nalo-gateway-access-policy';

@Controller('ussd/nalo')
@ApiTags('USSD sessions')
export class NaloUssdController {
  constructor(
    @Inject(USSD_PROVIDER) private readonly provider: UssdProvider,
    @Inject(USSD_FLOW_SERVICE) private readonly flow: UssdFlowService,
    @Inject(NALO_GATEWAY_ACCESS_POLICY)
    private readonly gatewayAccess: NaloGatewayAccessPolicy,
    private readonly logger: StructuredLogger,
  ) {}

  @Post('session')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive a Nalo USSD session request' })
  async handleSession(
    @RawBody() rawBody: Buffer | undefined,
    @Req() request: FastifyRequest,
  ): Promise<Record<string, unknown>> {
    // USERID is not a secret. Do not parse or act on a body from an unknown
    // source, and hide the disabled route from callers until Nalo is ready.
    if (!this.gatewayAccess.enabled || !this.gatewayAccess.allows(request.ip)) {
      throw new NotFoundException();
    }

    let parsed;
    try {
      if (rawBody === undefined) throw new UssdRequestError();
      const body: unknown = JSON.parse(rawBody.toString('utf8'));
      parsed = this.provider.parseRequest(body);
    } catch (error) {
      if (error instanceof UssdRequestError) {
        throw new BadRequestException({
          code: 'INVALID_USSD_REQUEST',
          message: 'The USSD request could not be trusted.',
        });
      }
      throw error;
    }

    const context: UssdFlowContext = { clientIp: request.ip };
    try {
      const outcome = await this.flow.handle(parsed, context);
      return this.provider.buildResponse(parsed, outcome) as Record<
        string,
        unknown
      >;
    } catch (error) {
      // The handset must always receive a renderable terminal screen; raw
      // internals never cross the gateway boundary.
      this.logger.error(
        `USSD session failed (failure=${error instanceof Error ? error.name : 'UNKNOWN'}).`,
        undefined,
        'NaloUssd',
      );
      return this.provider.buildResponse(parsed, {
        continueSession: false,
        message: 'Service temporarily unavailable. Please dial again later.',
      }) as Record<string, unknown>;
    }
  }
}
