import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { jsonApiResource } from '@edu-api/http';
import {
  VoucherBatchNotFoundError,
  VoucherBatchStateError,
  VoucherImportConflictError,
  VoucherImportValidationError,
} from '@edu-api/voucher-inventory';

import {
  ADMIN_VOUCHER_INVENTORY_OPERATIONS_SERVICE,
  type AdminVoucherBatch,
  type AdminVoucherInventoryOperationsService,
  VoucherBatchProductNotFoundError,
} from '../application/admin-voucher-inventory-operations';
import { AdminAuthorizationError } from '../application/admin-identity-errors';
import {
  AdminSessionGuard,
  type AdminAuthenticatedRequest,
  adminSessionCookieName,
} from './admin-session.guard';

@Controller('admin')
@ApiTags('Voucher inventory administration')
@ApiProduces('application/vnd.api+json')
@UseGuards(AdminSessionGuard)
@ApiCookieAuth(adminSessionCookieName)
export class AdminVoucherInventoryController {
  constructor(
    @Inject(ADMIN_VOUCHER_INVENTORY_OPERATIONS_SERVICE)
    private readonly inventory: AdminVoucherInventoryOperationsService,
  ) {}

  @Get('voucher-batches/:publicId')
  @ApiOperation({
    summary: 'Read an import batch status without exposing credentials',
  })
  @ApiOkResponse({ description: 'The voucher batch state.' })
  @ApiParam({ name: 'publicId', format: 'uuid' })
  async getBatch(
    @Param('publicId') publicId: string,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    try {
      return voucherBatchResource(
        await this.inventory.getBatch(requiredAdmin(request), publicId),
      );
    } catch (error) {
      throw asException(error);
    }
  }

  @Post('voucher-batches/import')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Import encrypted voucher credentials from CSV' })
  @ApiCreatedResponse({
    description: 'The voucher batch was imported but is not active yet.',
  })
  @ApiConsumes('text/csv')
  @ApiQuery({
    name: 'productPublicId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiQuery({
    name: 'reference',
    required: true,
    schema: { type: 'string', maxLength: 256 },
  })
  @ApiQuery({
    name: 'validUntil',
    required: false,
    schema: { type: 'string', format: 'date-time' },
  })
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  async importCsv(
    @Body() body: unknown,
    @Query('productPublicId') productPublicId: unknown,
    @Query('reference') reference: unknown,
    @Query('validUntil') validUntil: unknown,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    try {
      const batch = await this.inventory.importCsv(
        requiredAdmin(request),
        {
          productPublicId: requiredQueryString(
            productPublicId,
            'productPublicId',
          ),
          reference: requiredQueryString(reference, 'reference'),
          source: requiredCsvBody(body),
          ...(validUntil === undefined
            ? {}
            : { validUntil: parseValidUntil(validUntil) }),
        },
        requestContext(request),
      );
      return voucherBatchResource(batch);
    } catch (error) {
      throw asException(error);
    }
  }

  @Post('voucher-batches/:publicId/activate')
  @ApiOperation({ summary: 'Activate a completed voucher batch' })
  @ApiOkResponse({
    description: 'The imported vouchers are now eligible for allocation.',
  })
  @ApiParam({ name: 'publicId', format: 'uuid' })
  async activateBatch(
    @Param('publicId') publicId: string,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    try {
      const result = await this.inventory.activateBatch(
        requiredAdmin(request),
        publicId,
        requestContext(request),
      );
      return {
        ...voucherBatchResource(result.batch),
        meta: { changed: result.changed },
      };
    } catch (error) {
      throw asException(error);
    }
  }

  @Post('voucher-batches/:publicId/discard')
  @ApiOperation({
    summary:
      'Discard an inactive voucher batch and erase its encrypted credentials',
  })
  @ApiOkResponse({ description: 'The inactive batch was discarded.' })
  @ApiParam({ name: 'publicId', format: 'uuid' })
  async discardBatch(
    @Param('publicId') publicId: string,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    try {
      const batch = await this.inventory.discardBatch(
        requiredAdmin(request),
        publicId,
        requestContext(request),
      );
      return voucherBatchResource(batch);
    } catch (error) {
      throw asException(error);
    }
  }
}

function voucherBatchResource(batch: AdminVoucherBatch) {
  return jsonApiResource('voucher-batches', batch.publicId, {
    activatedAt: batch.activatedAt?.toISOString() ?? null,
    importState: batch.importState,
    productPublicId: batch.productPublicId,
    reference: batch.reference,
    totalQuantity: batch.totalQuantity,
    validUntil: batch.validUntil?.toISOString() ?? null,
  });
}

function requiredCsvBody(body: unknown): AsyncIterable<Uint8Array> {
  if (
    typeof body !== 'object' ||
    body === null ||
    !(Symbol.asyncIterator in body) ||
    typeof body[Symbol.asyncIterator] !== 'function'
  ) {
    throw new VoucherImportValidationError(
      'Request body must be a CSV stream.',
    );
  }
  return body as AsyncIterable<Uint8Array>;
}

function requiredQueryString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    throw new VoucherImportValidationError(`${name} is required.`);
  }
  return value;
}

function parseValidUntil(value: unknown): Date {
  const input = requiredQueryString(value, 'validUntil');
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      input,
    )
  ) {
    throw new VoucherImportValidationError(
      'validUntil must be an RFC 3339 date-time.',
    );
  }
  const result = new Date(input);
  if (Number.isNaN(result.getTime())) {
    throw new VoucherImportValidationError(
      'validUntil must be a valid date-time.',
    );
  }
  return result;
}

function requiredAdmin(request: AdminAuthenticatedRequest) {
  if (request.admin === undefined) {
    throw new ForbiddenException({
      code: 'ADMIN_AUTHENTICATION_REQUIRED',
      message: 'Administrator authentication is required.',
    });
  }
  return request.admin;
}

function requestContext(request: AdminAuthenticatedRequest) {
  return { correlationId: request.id };
}

function asException(error: unknown) {
  if (error instanceof VoucherImportValidationError) {
    return new BadRequestException({
      code: 'VOUCHER_IMPORT_INPUT_INVALID',
      message: error.message,
    });
  }
  if (
    error instanceof VoucherBatchProductNotFoundError ||
    error instanceof VoucherBatchNotFoundError
  ) {
    return new NotFoundException({
      code: 'VOUCHER_INVENTORY_RESOURCE_NOT_FOUND',
      message: error.message,
    });
  }
  if (
    error instanceof VoucherImportConflictError ||
    error instanceof VoucherBatchStateError
  ) {
    return new ConflictException({
      code: 'VOUCHER_INVENTORY_CONFLICT',
      message: error.message,
    });
  }
  if (error instanceof AdminAuthorizationError) {
    return new ForbiddenException({
      code: 'ADMIN_ACTION_FORBIDDEN',
      message: 'The administrator is not permitted to perform this action.',
    });
  }
  throw error;
}
