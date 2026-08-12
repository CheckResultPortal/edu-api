import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { jsonApiCollection, jsonApiResource } from '@edu-api/http';

import {
  CATALOG_PRODUCT_QUERY,
  type CatalogProductQuery,
  parseActiveCatalogProductsQuery,
} from '../application/catalog-product-query';
import { assertCatalogPublicId } from '../domain/catalog-validation';

@Controller('products')
@ApiTags('Catalog')
@ApiProduces('application/vnd.api+json')
export class PublicCatalogController {
  constructor(
    @Inject(CATALOG_PRODUCT_QUERY)
    private readonly products: CatalogProductQuery,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List active voucher products' })
  @ApiQuery({ name: 'catalogGroupPublicId', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { maximum: 100, minimum: 1 },
  })
  @ApiOkResponse({ description: 'A bounded page of active voucher products.' })
  async listProducts(
    @Query('catalogGroupPublicId') catalogGroupPublicId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const page = await this.products.listActiveProducts(
        parseActiveCatalogProductsQuery({
          ...(catalogGroupPublicId === undefined
            ? {}
            : { catalogGroupPublicId }),
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        }),
      );

      return jsonApiCollection(
        'products',
        page.items.map((product) => ({
          id: product.publicId,
          attributes: {
            catalogGroupPublicId: product.catalogGroupPublicId,
            code: product.code,
            currency: product.currency,
            description: product.description,
            name: product.name,
            resultCheckerUrl: product.resultCheckerUrl,
            sellingPriceMinor: product.sellingPriceMinor,
          },
        })),
        { nextCursor: page.nextCursor },
      );
    } catch (error) {
      throw this.asBadRequest(error);
    }
  }

  @Get(':publicId')
  @ApiOperation({ summary: 'Get an active voucher product' })
  @ApiOkResponse({ description: 'An active voucher product.' })
  @ApiNotFoundResponse({ description: 'The active product does not exist.' })
  async getProduct(@Param('publicId') publicId: string) {
    try {
      assertCatalogPublicId(publicId);
    } catch {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'The requested product does not exist.',
      });
    }

    const product = await this.products.getActiveProduct(publicId);
    if (product === null) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'The requested product does not exist.',
      });
    }

    return jsonApiResource('products', product.publicId, {
      catalogGroupPublicId: product.catalogGroupPublicId,
      code: product.code,
      currency: product.currency,
      description: product.description,
      name: product.name,
      resultCheckerUrl: product.resultCheckerUrl,
      sellingPriceMinor: product.sellingPriceMinor,
    });
  }

  private asBadRequest(error: unknown): BadRequestException {
    return new BadRequestException({
      code: 'INVALID_CATALOG_QUERY',
      message:
        error instanceof Error
          ? error.message
          : 'Catalog query parameters are invalid.',
    });
  }
}
