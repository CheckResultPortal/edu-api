export interface CatalogGroupDraft {
  readonly code: string;
  readonly name: string;
  readonly parentPublicId?: string;
  readonly sortOrder: number;
}

export interface CatalogProductDraft {
  readonly catalogGroupPublicId: string;
  readonly code: string;
  readonly currency: string;
  readonly description?: string;
  readonly lowStockThreshold: number;
  readonly name: string;
  readonly resultCheckerUrl?: string;
  readonly sellingPriceMinor: string;
  readonly sortOrder?: number;
}

export interface CatalogGroupPatch {
  readonly code?: string;
  readonly name?: string;
  readonly parentPublicId?: string | null;
  readonly sortOrder?: number;
}

export interface CatalogProductPatch {
  readonly catalogGroupPublicId?: string;
  readonly code?: string;
  readonly description?: string | null;
  readonly lowStockThreshold?: number;
  readonly name?: string;
  readonly resultCheckerUrl?: string | null;
  readonly sortOrder?: number;
}

const publicIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const codePattern = /^[A-Z][A-Z0-9_-]{1,63}$/;
const currencyPattern = /^[A-Z]{3}$/;
const positiveIntegerPattern = /^[1-9]\d*$/;

export function assertValidCatalogGroupDraft(draft: CatalogGroupDraft): void {
  assertCode(draft.code, 'Catalog group code');
  assertName(draft.name, 'Catalog group name');
  assertNonNegativeInteger(draft.sortOrder, 'Catalog group sort order');

  if (
    draft.parentPublicId !== undefined &&
    !publicIdPattern.test(draft.parentPublicId)
  ) {
    throw new Error('Catalog group parent public ID must be a UUID.');
  }
}

export function assertValidCatalogProductDraft(
  draft: CatalogProductDraft,
): void {
  if (!publicIdPattern.test(draft.catalogGroupPublicId)) {
    throw new Error('Product catalog group public ID must be a UUID.');
  }

  assertCode(draft.code, 'Product code');
  assertName(draft.name, 'Product name');

  if (
    draft.description !== undefined &&
    (draft.description.trim().length === 0 || draft.description.length > 2000)
  ) {
    throw new Error(
      'Product description must contain between 1 and 2000 characters when provided.',
    );
  }
  if (!positiveIntegerPattern.test(draft.sellingPriceMinor)) {
    throw new Error(
      'Product selling price must be a positive minor-unit integer.',
    );
  }
  if (!currencyPattern.test(draft.currency)) {
    throw new Error(
      'Product currency must be a three-letter uppercase ISO code.',
    );
  }
  if (draft.resultCheckerUrl !== undefined) {
    assertOfficialResultCheckerUrl(draft.resultCheckerUrl);
  }

  assertNonNegativeInteger(
    draft.lowStockThreshold,
    'Product low-stock threshold',
  );
  if (draft.sortOrder !== undefined) {
    assertNonNegativeInteger(draft.sortOrder, 'Product sort order');
  }
}

export function assertValidCatalogGroupPatch(patch: CatalogGroupPatch): void {
  if (
    patch.code === undefined &&
    patch.name === undefined &&
    patch.parentPublicId === undefined &&
    patch.sortOrder === undefined
  ) {
    throw new Error('Catalog group update must contain at least one field.');
  }

  if (patch.code !== undefined) assertCode(patch.code, 'Catalog group code');
  if (patch.name !== undefined) assertName(patch.name, 'Catalog group name');
  if (patch.sortOrder !== undefined) {
    assertNonNegativeInteger(patch.sortOrder, 'Catalog group sort order');
  }
  if (
    patch.parentPublicId !== undefined &&
    patch.parentPublicId !== null &&
    !publicIdPattern.test(patch.parentPublicId)
  ) {
    throw new Error('Catalog group parent public ID must be a UUID.');
  }
}

export function assertValidCatalogProductPatch(
  patch: CatalogProductPatch,
): void {
  if (
    patch.catalogGroupPublicId === undefined &&
    patch.code === undefined &&
    patch.description === undefined &&
    patch.lowStockThreshold === undefined &&
    patch.name === undefined &&
    patch.resultCheckerUrl === undefined &&
    patch.sortOrder === undefined
  ) {
    throw new Error('Product update must contain at least one field.');
  }

  if (
    patch.catalogGroupPublicId !== undefined &&
    !publicIdPattern.test(patch.catalogGroupPublicId)
  ) {
    throw new Error('Product catalog group public ID must be a UUID.');
  }
  if (patch.code !== undefined) assertCode(patch.code, 'Product code');
  if (patch.name !== undefined) assertName(patch.name, 'Product name');
  if (
    patch.description !== undefined &&
    patch.description !== null &&
    (patch.description.trim().length === 0 || patch.description.length > 2000)
  ) {
    throw new Error(
      'Product description must contain between 1 and 2000 characters when provided.',
    );
  }
  if (patch.resultCheckerUrl !== undefined && patch.resultCheckerUrl !== null) {
    assertOfficialResultCheckerUrl(patch.resultCheckerUrl);
  }
  if (patch.lowStockThreshold !== undefined) {
    assertNonNegativeInteger(
      patch.lowStockThreshold,
      'Product low-stock threshold',
    );
  }
  if (patch.sortOrder !== undefined) {
    assertNonNegativeInteger(patch.sortOrder, 'Product sort order');
  }
}

export function assertValidCatalogProductPrice(input: {
  readonly currency: string;
  readonly sellingPriceMinor: string;
}): void {
  if (!positiveIntegerPattern.test(input.sellingPriceMinor)) {
    throw new Error(
      'Product selling price must be a positive minor-unit integer.',
    );
  }
  if (!currencyPattern.test(input.currency)) {
    throw new Error(
      'Product currency must be a three-letter uppercase ISO code.',
    );
  }
}

function assertOfficialResultCheckerUrl(value: string): void {
  if (value.length > 2048) {
    throw new Error(
      'Product result-checker URL must not exceed 2048 characters.',
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Product result-checker URL must be a valid HTTPS URL.');
  }

  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error(
      'Product result-checker URL must be a credential-free HTTPS URL.',
    );
  }
}

export function assertCatalogPublicId(publicId: string): void {
  if (!publicIdPattern.test(publicId)) {
    throw new Error('Catalog public ID must be a UUID.');
  }
}

function assertCode(value: string, field: string): void {
  if (!codePattern.test(value)) {
    throw new Error(
      field +
        ' must start with an uppercase letter and contain only uppercase letters, digits, hyphens, or underscores.',
    );
  }
}

function assertName(value: string, field: string): void {
  if (value.trim().length === 0 || value.length > 160) {
    throw new Error(field + ' must contain between 1 and 160 characters.');
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(field + ' must be a non-negative safe integer.');
  }
}
