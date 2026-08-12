export interface DependencyReadiness {
  readonly database: boolean;
  readonly redis: boolean;
}

export function isReady(status: DependencyReadiness): boolean {
  return status.database && status.redis;
}
