export function databaseUrlFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const databaseUrl = environment.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be configured.');
  }

  return databaseUrl;
}
