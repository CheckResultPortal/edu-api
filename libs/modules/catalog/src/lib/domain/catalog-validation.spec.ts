import {
  assertValidCatalogGroupDraft,
  assertValidCatalogGroupPatch,
  assertValidCatalogProductDraft,
  assertValidCatalogProductPatch,
  assertValidCatalogProductPrice,
} from './catalog-validation';

const groupPublicId = '1f39d1f1-0e1b-4d7a-9b3a-fc3adca653a1';

describe('catalog validation', () => {
  it('accepts a hierarchical WAEC product definition', () => {
    expect(() =>
      assertValidCatalogGroupDraft({
        code: 'WAEC',
        name: 'West African Examinations Council',
        sortOrder: 0,
      }),
    ).not.toThrow();

    expect(() =>
      assertValidCatalogProductDraft({
        catalogGroupPublicId: groupPublicId,
        code: 'WAEC_WASSCE_RESULT_CHECKER',
        currency: 'GHS',
        lowStockThreshold: 25,
        name: 'WASSCE Result Checker',
        resultCheckerUrl: 'https://ghana.waecdirect.org/',
        sellingPriceMinor: '2500',
      }),
    ).not.toThrow();
  });

  it('rejects invalid money and threshold values', () => {
    expect(() =>
      assertValidCatalogProductDraft({
        catalogGroupPublicId: groupPublicId,
        code: 'WAEC_WASSCE_RESULT_CHECKER',
        currency: 'ghs',
        lowStockThreshold: -1,
        name: 'WASSCE Result Checker',
        sellingPriceMinor: '0',
      }),
    ).toThrow('positive minor-unit integer');
  });

  it('rejects unsafe or ambiguous identifiers', () => {
    expect(() =>
      assertValidCatalogGroupDraft({
        code: 'waec',
        name: 'WAEC',
        parentPublicId: 'not-a-uuid',
        sortOrder: 0,
      }),
    ).toThrow('Catalog group code');
  });

  it('rejects a result-checker URL that is not safe for customers', () => {
    expect(() =>
      assertValidCatalogProductDraft({
        catalogGroupPublicId: groupPublicId,
        code: 'WAEC_WASSCE_RESULT_CHECKER',
        currency: 'GHS',
        lowStockThreshold: 25,
        name: 'WASSCE Result Checker',
        resultCheckerUrl: 'http://username:password@example.test/',
        sellingPriceMinor: '2500',
      }),
    ).toThrow('credential-free HTTPS');
  });

  it('validates bounded partial updates and explicit price changes', () => {
    expect(() =>
      assertValidCatalogGroupPatch({ parentPublicId: null }),
    ).not.toThrow();
    expect(() =>
      assertValidCatalogProductPatch({
        description: null,
        resultCheckerUrl: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertValidCatalogProductPrice({
        currency: 'GHS',
        sellingPriceMinor: '1',
      }),
    ).not.toThrow();
    expect(() => assertValidCatalogGroupPatch({})).toThrow(
      'at least one field',
    );
    expect(() =>
      assertValidCatalogProductPatch({ description: ' '.repeat(2001) }),
    ).toThrow('between 1 and 2000');
  });
});
