import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../../../../generated/prisma/client';

import type { DatabaseClient } from '@edu-api/database';
import {
  type CatalogAdminService,
  type CatalogGroup,
  type CatalogProduct,
  type CatalogProductChange,
  type ChangeCatalogProductPriceInput,
  type CreateCatalogGroupInput,
  type CreateCatalogProductInput,
  type UpdateCatalogGroupInput,
  type UpdateCatalogProductInput,
  CatalogConflictError,
} from '@edu-api/catalog';

import { AdminAuthorizationError } from './admin-identity-errors';
import type {
  AuthenticatedAdmin,
  RequestContext,
} from './administration-types';

export const ADMIN_CATALOG_OPERATIONS_SERVICE = Symbol(
  'ADMIN_CATALOG_OPERATIONS_SERVICE',
);

export interface AdminCatalogOperationsService {
  createGroup(
    actor: AuthenticatedAdmin,
    input: CreateCatalogGroupInput,
    context: RequestContext,
  ): Promise<CatalogGroup>;
  updateGroup(
    actor: AuthenticatedAdmin,
    groupPublicId: string,
    input: UpdateCatalogGroupInput,
    context: RequestContext,
  ): Promise<CatalogGroup>;
  createProduct(
    actor: AuthenticatedAdmin,
    input: CreateCatalogProductInput,
    context: RequestContext,
  ): Promise<CatalogProduct>;
  updateProduct(
    actor: AuthenticatedAdmin,
    productPublicId: string,
    input: UpdateCatalogProductInput,
    context: RequestContext,
  ): Promise<CatalogProduct>;
  changeProductPrice(
    actor: AuthenticatedAdmin,
    productPublicId: string,
    input: ChangeCatalogProductPriceInput,
    context: RequestContext,
  ): Promise<CatalogProductChange>;
  setProductActivation(
    actor: AuthenticatedAdmin,
    productPublicId: string,
    isActive: boolean,
    context: RequestContext,
  ): Promise<CatalogProductChange>;
}

@Injectable()
export class PrismaAdminCatalogOperationsService
  implements AdminCatalogOperationsService
{
  constructor(
    private readonly database: DatabaseClient,
    private readonly catalog: CatalogAdminService,
  ) {}

  async createGroup(
    actor: AuthenticatedAdmin,
    input: CreateCatalogGroupInput,
    context: RequestContext,
  ): Promise<CatalogGroup> {
    this.assertCatalogOperator(actor);
    return this.inTransaction(async (transaction) => {
      const group = await this.catalog.createGroup(transaction, input);
      await this.recordAuditEvent(
        transaction,
        actor,
        context,
        'CATALOG_GROUP_CREATED',
        {
          catalogGroupPublicId: group.publicId,
        },
      );
      return group;
    });
  }

  async updateGroup(
    actor: AuthenticatedAdmin,
    groupPublicId: string,
    input: UpdateCatalogGroupInput,
    context: RequestContext,
  ): Promise<CatalogGroup> {
    this.assertCatalogOperator(actor);
    return this.inTransaction(async (transaction) => {
      const group = await this.catalog.updateGroup(
        transaction,
        groupPublicId,
        input,
      );
      await this.recordAuditEvent(
        transaction,
        actor,
        context,
        'CATALOG_GROUP_UPDATED',
        {
          catalogGroupPublicId: group.publicId,
        },
      );
      return group;
    });
  }

  async createProduct(
    actor: AuthenticatedAdmin,
    input: CreateCatalogProductInput,
    context: RequestContext,
  ): Promise<CatalogProduct> {
    this.assertCatalogOperator(actor);
    return this.inTransaction(async (transaction) => {
      const product = await this.catalog.createProduct(transaction, input);
      await this.recordAuditEvent(
        transaction,
        actor,
        context,
        'CATALOG_PRODUCT_CREATED',
        { productPublicId: product.publicId },
      );
      return product;
    });
  }

  async updateProduct(
    actor: AuthenticatedAdmin,
    productPublicId: string,
    input: UpdateCatalogProductInput,
    context: RequestContext,
  ): Promise<CatalogProduct> {
    this.assertCatalogOperator(actor);
    return this.inTransaction(async (transaction) => {
      const product = await this.catalog.updateProduct(
        transaction,
        productPublicId,
        input,
      );
      await this.recordAuditEvent(
        transaction,
        actor,
        context,
        'CATALOG_PRODUCT_UPDATED',
        { productPublicId: product.publicId },
      );
      return product;
    });
  }

  async changeProductPrice(
    actor: AuthenticatedAdmin,
    productPublicId: string,
    input: ChangeCatalogProductPriceInput,
    context: RequestContext,
  ): Promise<CatalogProductChange> {
    this.assertCatalogOperator(actor);
    return this.inTransaction(async (transaction) => {
      const result = await this.catalog.changeProductPrice(
        transaction,
        productPublicId,
        input,
      );
      await this.recordAuditEvent(
        transaction,
        actor,
        context,
        'CATALOG_PRODUCT_PRICE_CHANGED',
        {
          changed: result.changed,
          productPublicId: result.product.publicId,
        },
      );
      return result;
    });
  }

  async setProductActivation(
    actor: AuthenticatedAdmin,
    productPublicId: string,
    isActive: boolean,
    context: RequestContext,
  ): Promise<CatalogProductChange> {
    this.assertCatalogOperator(actor);
    return this.inTransaction(async (transaction) => {
      const result = await this.catalog.setProductActivation(
        transaction,
        productPublicId,
        isActive,
      );
      await this.recordAuditEvent(
        transaction,
        actor,
        context,
        'CATALOG_PRODUCT_ACTIVATION_CHANGED',
        {
          changed: result.changed,
          isActive: result.product.isActive,
          productPublicId: result.product.publicId,
        },
      );
      return result;
    });
  }

  private async inTransaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 10_000,
      });
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        throw new CatalogConflictError(
          'A catalog record already exists with one of the supplied unique values.',
        );
      }
      if (prismaErrorCode(error) === 'P2034') {
        throw new CatalogConflictError(
          'The catalog changed concurrently. Retry the operation.',
        );
      }
      throw error;
    }
  }

  private async recordAuditEvent(
    transaction: Prisma.TransactionClient,
    actor: AuthenticatedAdmin,
    context: RequestContext,
    eventType: string,
    metadata: Readonly<Record<string, boolean | string>>,
  ): Promise<void> {
    await transaction.adminSecurityEvent.create({
      data: {
        adminUserId: actor.id,
        correlationId: context.correlationId,
        eventType,
        metadata,
      },
    });
  }

  private assertCatalogOperator(actor: AuthenticatedAdmin): void {
    if (actor.role !== 'SUPER_ADMIN' && actor.role !== 'OPERATIONS_ADMIN') {
      throw new AdminAuthorizationError();
    }
  }
}

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? typeof error.code === 'string'
      ? error.code
      : undefined
    : undefined;
}
