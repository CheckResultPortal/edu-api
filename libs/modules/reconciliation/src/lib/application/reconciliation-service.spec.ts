import { reconciliationFingerprint } from './reconciliation-service';

describe('reconciliationFingerprint', () => {
  it('is stable per mismatch and distinct across mismatch types', () => {
    const reference = '1f39d1f1-0e1b-4d7a-9b3a-fc3adca653a1';
    expect(reconciliationFingerprint('TYPE_A', reference)).toBe(
      reconciliationFingerprint('TYPE_A', reference),
    );
    expect(reconciliationFingerprint('TYPE_A', reference)).not.toBe(
      reconciliationFingerprint('TYPE_B', reference),
    );
  });
});
