export function createServiceTestEnvironment(
  serviceName: string,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    LOG_LEVEL: 'error',
    NODE_ENV: 'test',
    SERVICE_NAME: serviceName,
    ...overrides,
  };
}

export * from './shutdown';
export * from './dependency-readiness';
