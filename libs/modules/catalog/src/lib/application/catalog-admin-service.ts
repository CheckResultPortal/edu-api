import type { Prisma } from '../../../../../../generated/prisma/client';

export const CATALOG_ADMIN_SERVICE = Symbol('CATALOG_ADMIN_SERVICE');

export interface CatalogAdminService {
  createGroup(
    transaction: Prisma.TransactionClient,
    input: CreateCatalogGroupInput,
  ): Promise<CatalogGroup>;
  updateGroup(
    transaction: Prisma.TransactionClient,
    groupPublicId: string,
    input: UpdateCatalogGroupInput,
  ): Promise<CatalogGroup>;
  createProduct(
    transaction: Prisma.TransactionClient,
    input: CreateCatalogProductInput,
  ): Promise<CatalogProduct>;
  updateProduct(
    transaction: Prisma.TransactionClient,
    productPublicId: string,
    input: UpdateCatalogProductInput,
  ): Promise<CatalogProduct>;
  changeProductPrice(
    transaction: Prisma.TransactionClient,
    productPublicId: string,
    input: ChangeCatalogProductPriceInput,
  ): Promise<CatalogProductChange>;
  setProductActivation(
    transaction: Prisma.TransactionClient,
    productPublicId: string,
    isActive: boolean,
  ): Promise<CatalogProductChange>;
}

export interface CatalogGroup {
  readonly code: string;
  readonly name: string;
  readonly parentPublicId: string | null;
  readonly publicId: string;
  readonly sortOrder: number;
}

export interface CatalogProduct {
  readonly catalogGroupPublicId: string;
  readonly code: string;
  readonly currency: string;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly lowStockThreshold: number;
  readonly name: string;
  readonly publicId: string;
  readonly resultCheckerUrl: string | null;
  readonly sellingPriceMinor: string;
}

export interface CatalogProductChange {
  readonly changed: boolean;
  readonly product: CatalogProduct;
}

export interface CreateCatalogGroupInput {
  readonly code: string;
  readonly name: string;
  readonly parentPublicId?: string;
  readonly sortOrder: number;
}

export interface UpdateCatalogGroupInput {
  readonly code?: string;
  readonly name?: string;
  readonly parentPublicId?: string | null;
  readonly sortOrder?: number;
}

export interface CreateCatalogProductInput {
  readonly catalogGroupPublicId: string;
  readonly code: string;
  readonly currency: string;
  readonly description?: string;
  readonly lowStockThreshold: number;
  readonly name: string;
  readonly resultCheckerUrl?: string;
  readonly sellingPriceMinor: string;
}

export interface UpdateCatalogProductInput {
  readonly catalogGroupPublicId?: string;
  readonly code?: string;
  readonly description?: string | null;
  readonly lowStockThreshold?: number;
  readonly name?: string;
  readonly resultCheckerUrl?: string | null;
}

export interface ChangeCatalogProductPriceInput {
  readonly currency: string;
  readonly sellingPriceMinor: string;
}
