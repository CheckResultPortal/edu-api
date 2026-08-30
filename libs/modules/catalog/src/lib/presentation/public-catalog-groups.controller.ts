import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { jsonApiCollection } from '@edu-api/http';

import {
  CATALOG_GROUP_QUERY,
  type CatalogGroupQuery,
  parseCatalogGroupsQuery,
} from '../application/catalog-group-query';

@Controller('catalog-groups')
@ApiTags('Catalog')
@ApiProduces('application/vnd.api+json')
export class PublicCatalogGroupsController {
  constructor(
    @Inject(CATALOG_GROUP_QUERY)
    private readonly groups: CatalogGroupQuery,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List the public product catalog hierarchy' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { minimum: 1, maximum: 100 },
  })
  @ApiOkResponse({ description: 'A bounded page of public catalog groups.' })
  async list(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    try {
      const page = await this.groups.listGroups(
        parseCatalogGroupsQuery({
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        }),
      );
      return jsonApiCollection(
        'catalog-groups',
        page.items.map((group) => ({
          id: group.publicId,
          attributes: {
            code: group.code,
            name: group.name,
            parentPublicId: group.parentPublicId,
            sortOrder: group.sortOrder,
          },
        })),
        { nextCursor: page.nextCursor },
      );
    } catch (error) {
      throw new BadRequestException({
        code: 'INVALID_CATALOG_GROUP_QUERY',
        message:
          error instanceof Error
            ? error.message
            : 'Catalog group query parameters are invalid.',
      });
    }
  }
}
