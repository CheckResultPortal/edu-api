import { createHash } from 'node:crypto';

export const RECONCILIATION_SERVICE = Symbol('RECONCILIATION_SERVICE');

export interface ReconciliationCycleResult {
  readonly detected: number;
  readonly resolved: number;
}

export interface ReconciliationService {
  process(limit: number): Promise<ReconciliationCycleResult>;
}

export function reconciliationFingerprint(
  type: string,
  sourcePublicReference: string,
): string {
  return createHash('sha256')
    .update(`${type}:${sourcePublicReference}`)
    .digest('base64url');
}
