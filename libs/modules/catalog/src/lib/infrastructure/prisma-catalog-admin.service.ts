import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../../../../generated/prisma/client';

import { assertValidOutboxEvent } from '@edu-api/outbox';

import {
  CatalogNotFoundError,
  CatalogValidationError,
} from '../application/catalog-admin-errors';
import type {
  CatalogAdminService,
  CatalogGroup,
  CatalogProduct,
  CatalogProductChange,
  ChangeCatalogProductPriceInput,
  CreateCatalogGroupInput,
  CreateCatalogProductInput,
  UpdateCatalogGroupInput,
  UpdateCatalogProductInput,
} from '../application/catalog-admin-service';
import {
  assertCatalogPublicId,
  assertValidCatalogGroupDraft,
  assertValidCatalogGroupPatch,
  assertValidCatalogProductDraft,
  assertValidCatalogProductPatch,
  assertValidCatalogProductPrice,
} from '../domain/catalog-validation';

@Injectable()
export class PrismaCatalogAdminService implements CatalogAdminService {
  async createGroup(
    transaction: Prisma.TransactionClient,
    input: CreateCatalogGroupInput,
  ): Promise<CatalogGroup> {
    this.validate(() => assertValidCatalogGroupDraft(input));
    const parent =
      input.parentPublicId === undefined
        ? null
        : await this.findGroupByPublicId(
            transaction,
            input.parentPublicId,
            'Catalog group parent was not found.',
          );

    const group = await transaction.catalogGroup.create({
      data: {
        code: input.code,
        name: input.name,
        parentId: parent?.id,
        sortOrder: input.sortOrder,
      },
      select: catalogGroupSelection,
    });
    return toCatalogGroup(group);
  }

  async updateGroup(
    transaction: Prisma.TransactionClient,
    groupPublicId: string,
    input: UpdateCatalogGroupInput,
  ): Promise<CatalogGroup> {
    this.validate(() => {
      assertCatalogPublicId(groupPublicId);
      assertValidCatalogGroupPatch(input);
    });
    const group = await this.findGroupByPublicId(
      transaction,
      groupPublicId,
      'Catalog group was not found.',
    );

    const parentId = await this.resolveUpdatedParentId(
      transaction,
      group.id,
      input.parentPublicId,
    );
    const updated = await transaction.catalogGroup.update({
      where: { id: group.id },
      data: {
        ...(input.code === undefined ? {} : { code: input.code }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(parentId === undefined ? {} : { parentId }),
        ...(input.sortOrder === undefined
          ? {}
          : { sortOrder: input.sortOrder }),
      },
      select: catalogGroupSelection,
    });
    return toCatalogGroup(updated);
  }

  async createProduct(
    transaction: Prisma.TransactionClient,
    input: CreateCatalogProductInput,
  ): Promise<CatalogProduct> {
    this.validate(() => assertValidCatalogProductDraft(input));
    const group = await this.findGroupByPublicId(
      transaction,
      input.catalogGroupPublicId,
      'Product catalog group was not found.',
    );
    const product = await transaction.product.create({
      data: {
        catalogGroupId: group.id,
        code: input.code,
        currency: input.currency,
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        lowStockThreshold: input.lowStockThreshold,
        name: input.name,
        ...(input.resultCheckerUrl === undefined
          ? {}
          : { resultCheckerUrl: input.resultCheckerUrl }),
        sellingPriceMinor: BigInt(input.sellingPriceMinor),
        ...(input.sortOrder === undefined
          ? {}
          : { sortOrder: input.sortOrder }),
      },
      select: productSelection,
    });
    await this.createProductOutboxEvent(transaction, product, 'Created');
    return toCatalogProduct(product);
  }

  async updateProduct(
    transaction: Prisma.TransactionClient,
    productPublicId: string,
    input: UpdateCatalogProductInput,
  ): Promise<CatalogProduct> {
    this.validate(() => {
      assertCatalogPublicId(productPublicId);
      assertValidCatalogProductPatch(input);
    });
    const product = await this.findProductByPublicId(
      transaction,
      productPublicId,
    );
    const catalogGroupId =
      input.catalogGroupPublicId === undefined
        ? undefined
        : (
            await this.findGroupByPublicId(
              transaction,
              input.catalogGroupPublicId,
              'Product catalog group was not found.',
            )
          ).id;
    const updated = await transaction.product.update({
      where: { id: product.id },
      data: {
        ...(catalogGroupId === undefined ? {} : { catalogGroupId }),
        ...(input.code === undefined ? {} : { code: input.code }),
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        ...(input.lowStockThreshold === undefined
          ? {}
          : { lowStockThreshold: input.lowStockThreshold }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.resultCheckerUrl === undefined
          ? {}
          : { resultCheckerUrl: input.resultCheckerUrl }),
        ...(input.sortOrder === undefined
          ? {}
          : { sortOrder: input.sortOrder }),
      },
      select: productSelection,
    });
    return toCatalogProduct(updated);
  }

  async changeProductPrice(
    transaction: Prisma.TransactionClient,
    productPublicId: string,
    input: ChangeCatalogProductPriceInput,
  ): Promise<CatalogProductChange> {
    this.validate(() => {
      assertCatalogPublicId(productPublicId);
      assertValidCatalogProductPrice(input);
    });
    const product = await this.findProductByPublicId(
      transaction,
      productPublicId,
    );
    const sellingPriceMinor = BigInt(input.sellingPriceMinor);
    const changed =
      product.currency !== input.currency ||
      product.sellingPriceMinor !== sellingPriceMinor;
    const updated = changed
      ? await transaction.product.update({
          where: { id: product.id },
          data: { currency: input.currency, sellingPriceMinor },
          select: productSelection,
        })
      : product;
    if (changed) {
      await this.createProductOutboxEvent(transaction, updated, 'PriceChanged');
    }
    return { changed, product: toCatalogProduct(updated) };
  }

  async setProductActivation(
    transaction: Prisma.TransactionClient,
    productPublicId: string,
    isActive: boolean,
  ): Promise<CatalogProductChange> {
    this.validate(() => assertCatalogPublicId(productPublicId));
    const product = await this.findProductByPublicId(
      transaction,
      productPublicId,
    );
    const changed = product.isActive !== isActive;
    const updated = changed
      ? await transaction.product.update({
          where: { id: product.id },
          data: { isActive },
          select: productSelection,
        })
      : product;
    if (changed) {
      await this.createProductOutboxEvent(
        transaction,
        updated,
        'ActivationChanged',
      );
    }
    return { changed, product: toCatalogProduct(updated) };
  }

  private async resolveUpdatedParentId(
    transaction: Prisma.TransactionClient,
    groupId: bigint,
    parentPublicId: string | null | undefined,
  ): Promise<bigint | null | undefined> {
    if (parentPublicId === undefined) return undefined;
    if (parentPublicId === null) return null;

    const parent = await this.findGroupByPublicId(
      transaction,
      parentPublicId,
      'Catalog group parent was not found.',
    );
    if (parent.id === groupId) {
      throw new CatalogValidationError('A catalog group cannot be its parent.');
    }

    const cycle = await transaction.$queryRaw<readonly { id: bigint }[]>`
      WITH RECURSIVE ancestors (id, "parentId", path, cycle) AS (
        SELECT "id", "parentId", ARRAY["id"], false
        FROM "CatalogGroup"
        WHERE "id" = ${parent.id}
        UNION ALL
        SELECT current."id", current."parentId", ancestors.path || current."id",
          current."id" = ANY(ancestors.path)
        FROM "CatalogGroup" AS current
        INNER JOIN ancestors ON current."id" = ancestors."parentId"
        WHERE NOT ancestors.cycle
      )
      SELECT "id"
      FROM ancestors
      WHERE "id" = ${groupId}
      LIMIT 1
    `;
    if (cycle.length !== 0) {
      throw new CatalogValidationError(
        'Catalog group move would create an ancestor cycle.',
      );
    }
    return parent.id;
  }

  private async findGroupByPublicId(
    transaction: Prisma.TransactionClient,
    publicId: string,
    message: string,
  ) {
    const group = await transaction.catalogGroup.findUnique({
      where: { publicId },
      select: { id: true },
    });
    if (group === null) throw new CatalogNotFoundError(message);
    return group;
  }

  private async findProductByPublicId(
    transaction: Prisma.TransactionClient,
    publicId: string,
  ) {
    const product = await transaction.product.findUnique({
      where: { publicId },
      select: productSelection,
    });
    if (product === null) {
      throw new CatalogNotFoundError('Product was not found.');
    }
    return product;
  }

  private async createProductOutboxEvent(
    transaction: Prisma.TransactionClient,
    product: ProductRecord,
    suffix: 'ActivationChanged' | 'Created' | 'PriceChanged',
  ): Promise<void> {
    const event = {
      aggregateId: product.id.toString(),
      aggregateType: 'CatalogProduct',
      eventType: `CatalogProduct${suffix}`,
      payload: {
        catalogGroupPublicId: product.catalogGroup.publicId,
        currency: product.currency,
        isActive: product.isActive,
        productPublicId: product.publicId,
        sellingPriceMinor: product.sellingPriceMinor.toString(),
        version: 1,
      },
    } as const;
    assertValidOutboxEvent(event);
    await transaction.outboxEvent.create({
      data: {
        aggregateId: product.id,
        aggregateType: event.aggregateType,
        eventType: event.eventType,
        payload: event.payload,
      },
    });
  }

  private validate(action: () => void): void {
    try {
      action();
    } catch (error) {
      throw new CatalogValidationError(
        error instanceof Error ? error.message : 'Catalog input is invalid.',
      );
    }
  }
}

const catalogGroupSelection = {
  publicId: true,
  code: true,
  name: true,
  sortOrder: true,
  parent: { select: { publicId: true } },
} as const;

const productSelection = {
  id: true,
  publicId: true,
  code: true,
  name: true,
  description: true,
  sellingPriceMinor: true,
  currency: true,
  resultCheckerUrl: true,
  lowStockThreshold: true,
  sortOrder: true,
  isActive: true,
  catalogGroup: { select: { publicId: true } },
} as const;

type ProductRecord = {
  readonly catalogGroup: { readonly publicId: string };
  readonly code: string;
  readonly currency: string;
  readonly description: string | null;
  readonly id: bigint;
  readonly isActive: boolean;
  readonly lowStockThreshold: number;
  readonly name: string;
  readonly publicId: string;
  readonly resultCheckerUrl: string | null;
  readonly sellingPriceMinor: bigint;
  readonly sortOrder: number;
};

function toCatalogGroup(group: {
  readonly code: string;
  readonly name: string;
  readonly parent: { readonly publicId: string } | null;
  readonly publicId: string;
  readonly sortOrder: number;
}): CatalogGroup {
  return {
    code: group.code,
    name: group.name,
    parentPublicId: group.parent?.publicId ?? null,
    publicId: group.publicId,
    sortOrder: group.sortOrder,
  };
}

function toCatalogProduct(product: ProductRecord): CatalogProduct {
  return {
    catalogGroupPublicId: product.catalogGroup.publicId,
    code: product.code,
    currency: product.currency,
    description: product.description,
    isActive: product.isActive,
    lowStockThreshold: product.lowStockThreshold,
    name: product.name,
    publicId: product.publicId,
    resultCheckerUrl: product.resultCheckerUrl,
    sellingPriceMinor: product.sellingPriceMinor.toString(),
    sortOrder: product.sortOrder,
  };
}
