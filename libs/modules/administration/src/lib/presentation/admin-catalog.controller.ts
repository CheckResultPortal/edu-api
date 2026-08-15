import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';

import {
  CatalogConflictError,
  CatalogNotFoundError,
  CatalogValidationError,
  type CatalogGroup,
  type CatalogProduct,
  type ChangeCatalogProductPriceInput,
  type CreateCatalogGroupInput,
  type CreateCatalogProductInput,
  type UpdateCatalogGroupInput,
  type UpdateCatalogProductInput,
} from '@edu-api/catalog';
import { jsonApiResource } from '@edu-api/http';

import {
  ADMIN_CATALOG_OPERATIONS_SERVICE,
  type AdminCatalogOperationsService,
} from '../application/admin-catalog-operations';
import { AdminAuthorizationError } from '../application/admin-identity-errors';
import {
  AdminSessionGuard,
  type AdminAuthenticatedRequest,
  adminSessionCookieName,
} from './admin-session.guard';

type RequestBodySchema = Extract<
  Parameters<typeof ApiBody>[0],
  { schema: unknown }
>['schema'];

const groupCreateRequestSchema: RequestBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'name', 'sortOrder'],
  properties: {
    code: { type: 'string', maxLength: 64 },
    name: { type: 'string', maxLength: 160 },
    parentPublicId: { type: 'string', format: 'uuid' },
    sortOrder: { type: 'integer', minimum: 0 },
  },
};

const groupUpdateRequestSchema: RequestBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    code: { type: 'string', maxLength: 64 },
    name: { type: 'string', maxLength: 160 },
    parentPublicId: { type: 'string', format: 'uuid', nullable: true },
    sortOrder: { type: 'integer', minimum: 0 },
  },
};

const productCreateRequestSchema: RequestBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'catalogGroupPublicId',
    'code',
    'currency',
    'lowStockThreshold',
    'name',
    'sellingPriceMinor',
  ],
  properties: {
    catalogGroupPublicId: { type: 'string', format: 'uuid' },
    code: { type: 'string', maxLength: 64 },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    description: { type: 'string', maxLength: 2000 },
    lowStockThreshold: { type: 'integer', minimum: 0 },
    name: { type: 'string', maxLength: 160 },
    resultCheckerUrl: { type: 'string', format: 'uri', maxLength: 2048 },
    sellingPriceMinor: { type: 'string', pattern: '^[1-9]\\d*$' },
  },
};

const productUpdateRequestSchema: RequestBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    catalogGroupPublicId: { type: 'string', format: 'uuid' },
    code: { type: 'string', maxLength: 64 },
    description: { type: 'string', maxLength: 2000, nullable: true },
    lowStockThreshold: { type: 'integer', minimum: 0 },
    name: { type: 'string', maxLength: 160 },
    resultCheckerUrl: {
      type: 'string',
      format: 'uri',
      maxLength: 2048,
      nullable: true,
    },
  },
};

const productPriceRequestSchema: RequestBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['currency', 'sellingPriceMinor'],
  properties: {
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    sellingPriceMinor: { type: 'string', pattern: '^[1-9]\\d*$' },
  },
};

@Controller('admin')
@ApiTags('Catalog administration')
@ApiProduces('application/vnd.api+json')
@UseGuards(AdminSessionGuard)
@ApiCookieAuth(adminSessionCookieName)
export class AdminCatalogController {
  constructor(
    @Inject(ADMIN_CATALOG_OPERATIONS_SERVICE)
    private readonly catalog: AdminCatalogOperationsService,
  ) {}

  @Post('catalog-groups')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a catalog group' })
  @ApiCreatedResponse({ description: 'The catalog group was created.' })
  @ApiBody({ schema: groupCreateRequestSchema })
  async createGroup(
    @Body() body: unknown,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    try {
      const group = await this.catalog.createGroup(
        requiredAdmin(request),
        parseCreateGroupBody(body),
        requestContext(request),
      );
      return catalogGroupResource(group);
    } catch (error) {
      throw this.asException(error);
    }
  }

  @Patch('catalog-groups/:publicId')
  @ApiOperation({ summary: 'Update or move a catalog group' })
  @ApiOkResponse({ description: 'The catalog group was updated.' })
  @ApiParam({ name: 'publicId', format: 'uuid' })
  @ApiBody({ schema: groupUpdateRequestSchema })
  async updateGroup(
    @Param('publicId') publicId: string,
    @Body() body: unknown,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    try {
      const group = await this.catalog.updateGroup(
        requiredAdmin(request),
        publicId,
        parseUpdateGroupBody(body),
        requestContext(request),
      );
      return catalogGroupResource(group);
    } catch (error) {
      throw this.asException(error);
    }
  }

  @Post('products')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a sellable catalog product' })
  @ApiCreatedResponse({ description: 'The product was created.' })
  @ApiBody({ schema: productCreateRequestSchema })
  async createProduct(
    @Body() body: unknown,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    try {
      const product = await this.catalog.createProduct(
        requiredAdmin(request),
        parseCreateProductBody(body),
        requestContext(request),
      );
      return catalogProductResource(product);
    } catch (error) {
      throw this.asException(error);
    }
  }

  @Patch('products/:publicId')
  @ApiOperation({ summary: 'Update product details or catalogue grouping' })
  @ApiOkResponse({ description: 'The product was updated.' })
  @ApiParam({ name: 'publicId', format: 'uuid' })
  @ApiBody({ schema: productUpdateRequestSchema })
  async updateProduct(
    @Param('publicId') publicId: string,
    @Body() body: unknown,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    try {
      const product = await this.catalog.updateProduct(
        requiredAdmin(request),
        publicId,
        parseUpdateProductBody(body),
        requestContext(request),
      );
      return catalogProductResource(product);
    } catch (error) {
      throw this.asException(error);
    }
  }

  @Put('products/:publicId/price')
  @ApiOperation({ summary: 'Change an authoritative product price' })
  @ApiOkResponse({ description: 'The product price was updated.' })
  @ApiParam({ name: 'publicId', format: 'uuid' })
  @ApiBody({ schema: productPriceRequestSchema })
  async changeProductPrice(
    @Param('publicId') publicId: string,
    @Body() body: unknown,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    try {
      const result = await this.catalog.changeProductPrice(
        requiredAdmin(request),
        publicId,
        parseProductPriceBody(body),
        requestContext(request),
      );
      return catalogProductResource(result.product, {
        changed: result.changed,
      });
    } catch (error) {
      throw this.asException(error);
    }
  }

  @Post('products/:publicId/activate')
  @ApiOperation({ summary: 'Activate a catalog product' })
  @ApiOkResponse({ description: 'The product is active.' })
  @ApiParam({ name: 'publicId', format: 'uuid' })
  async activateProduct(
    @Param('publicId') publicId: string,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.setProductActivation(publicId, true, request);
  }

  @Post('products/:publicId/deactivate')
  @ApiOperation({ summary: 'Deactivate a catalog product' })
  @ApiOkResponse({ description: 'The product is inactive.' })
  @ApiParam({ name: 'publicId', format: 'uuid' })
  async deactivateProduct(
    @Param('publicId') publicId: string,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.setProductActivation(publicId, false, request);
  }

  private async setProductActivation(
    publicId: string,
    isActive: boolean,
    request: AdminAuthenticatedRequest,
  ) {
    try {
      const result = await this.catalog.setProductActivation(
        requiredAdmin(request),
        publicId,
        isActive,
        requestContext(request),
      );
      return catalogProductResource(result.product, {
        changed: result.changed,
      });
    } catch (error) {
      throw this.asException(error);
    }
  }

  private asException(error: unknown) {
    if (error instanceof CatalogValidationError) {
      return new BadRequestException({
        code: 'CATALOG_INPUT_INVALID',
        message: error.message,
      });
    }
    if (error instanceof CatalogNotFoundError) {
      return new NotFoundException({
        code: 'CATALOG_RESOURCE_NOT_FOUND',
        message: error.message,
      });
    }
    if (error instanceof CatalogConflictError) {
      return new ConflictException({
        code: 'CATALOG_CONFLICT',
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
}

function catalogGroupResource(group: CatalogGroup) {
  return jsonApiResource('catalog-groups', group.publicId, {
    code: group.code,
    name: group.name,
    parentPublicId: group.parentPublicId,
    sortOrder: group.sortOrder,
  });
}

function catalogProductResource(
  product: CatalogProduct,
  meta?: Readonly<Record<string, boolean>>,
) {
  return {
    ...jsonApiResource('products', product.publicId, {
      catalogGroupPublicId: product.catalogGroupPublicId,
      code: product.code,
      currency: product.currency,
      description: product.description,
      isActive: product.isActive,
      lowStockThreshold: product.lowStockThreshold,
      name: product.name,
      resultCheckerUrl: product.resultCheckerUrl,
      sellingPriceMinor: product.sellingPriceMinor,
    }),
    ...(meta === undefined ? {} : { meta }),
  };
}

function parseCreateGroupBody(body: unknown): CreateCatalogGroupInput {
  const object = objectBody(body, [
    'code',
    'name',
    'parentPublicId',
    'sortOrder',
  ]);
  return {
    code: requiredString(object, 'code'),
    name: requiredString(object, 'name'),
    ...(optionalString(object, 'parentPublicId') === undefined
      ? {}
      : { parentPublicId: optionalString(object, 'parentPublicId') }),
    sortOrder: requiredInteger(object, 'sortOrder'),
  };
}

function parseUpdateGroupBody(body: unknown): UpdateCatalogGroupInput {
  const object = objectBody(body, [
    'code',
    'name',
    'parentPublicId',
    'sortOrder',
  ]);
  const parentPublicId = optionalNullableString(object, 'parentPublicId');
  return {
    ...(optionalString(object, 'code') === undefined
      ? {}
      : { code: optionalString(object, 'code') }),
    ...(optionalString(object, 'name') === undefined
      ? {}
      : { name: optionalString(object, 'name') }),
    ...(parentPublicId === undefined ? {} : { parentPublicId }),
    ...(optionalInteger(object, 'sortOrder') === undefined
      ? {}
      : { sortOrder: optionalInteger(object, 'sortOrder') }),
  };
}

function parseCreateProductBody(body: unknown): CreateCatalogProductInput {
  const object = objectBody(body, [
    'catalogGroupPublicId',
    'code',
    'currency',
    'description',
    'lowStockThreshold',
    'name',
    'resultCheckerUrl',
    'sellingPriceMinor',
  ]);
  return {
    catalogGroupPublicId: requiredString(object, 'catalogGroupPublicId'),
    code: requiredString(object, 'code'),
    currency: requiredString(object, 'currency'),
    ...(optionalString(object, 'description') === undefined
      ? {}
      : { description: optionalString(object, 'description') }),
    lowStockThreshold: requiredInteger(object, 'lowStockThreshold'),
    name: requiredString(object, 'name'),
    ...(optionalString(object, 'resultCheckerUrl') === undefined
      ? {}
      : { resultCheckerUrl: optionalString(object, 'resultCheckerUrl') }),
    sellingPriceMinor: requiredString(object, 'sellingPriceMinor'),
  };
}

function parseUpdateProductBody(body: unknown): UpdateCatalogProductInput {
  const object = objectBody(body, [
    'catalogGroupPublicId',
    'code',
    'description',
    'lowStockThreshold',
    'name',
    'resultCheckerUrl',
  ]);
  const description = optionalNullableString(object, 'description');
  const resultCheckerUrl = optionalNullableString(object, 'resultCheckerUrl');
  return {
    ...(optionalString(object, 'catalogGroupPublicId') === undefined
      ? {}
      : {
          catalogGroupPublicId: optionalString(object, 'catalogGroupPublicId'),
        }),
    ...(optionalString(object, 'code') === undefined
      ? {}
      : { code: optionalString(object, 'code') }),
    ...(description === undefined ? {} : { description }),
    ...(optionalInteger(object, 'lowStockThreshold') === undefined
      ? {}
      : { lowStockThreshold: optionalInteger(object, 'lowStockThreshold') }),
    ...(optionalString(object, 'name') === undefined
      ? {}
      : { name: optionalString(object, 'name') }),
    ...(resultCheckerUrl === undefined ? {} : { resultCheckerUrl }),
  };
}

function parseProductPriceBody(body: unknown): ChangeCatalogProductPriceInput {
  const object = objectBody(body, ['currency', 'sellingPriceMinor']);
  return {
    currency: requiredString(object, 'currency'),
    sellingPriceMinor: requiredString(object, 'sellingPriceMinor'),
  };
}

function objectBody(
  body: unknown,
  allowedProperties: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidBody('Request body must be an object.');
  }
  const object = body as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(object)) {
    if (!allowedProperties.includes(key)) {
      throw invalidBody(`Unexpected request field: ${key}.`);
    }
  }
  return object;
}

function requiredString(
  object: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = object[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw invalidBody(`${name} is required.`);
  }
  return value;
}

function optionalString(
  object: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  if (!(name in object)) return undefined;
  return requiredString(object, name);
}

function optionalNullableString(
  object: Readonly<Record<string, unknown>>,
  name: string,
): string | null | undefined {
  if (!(name in object)) return undefined;
  if (object[name] === null) return null;
  return requiredString(object, name);
}

function requiredInteger(
  object: Readonly<Record<string, unknown>>,
  name: string,
): number {
  const value = object[name];
  if (!Number.isSafeInteger(value)) {
    throw invalidBody(`${name} must be an integer.`);
  }
  return value as number;
}

function optionalInteger(
  object: Readonly<Record<string, unknown>>,
  name: string,
): number | undefined {
  if (!(name in object)) return undefined;
  return requiredInteger(object, name);
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

function invalidBody(message: string): BadRequestException {
  return new BadRequestException({ code: 'CATALOG_INPUT_INVALID', message });
}
