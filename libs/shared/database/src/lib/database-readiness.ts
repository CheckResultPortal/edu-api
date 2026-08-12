export interface DatabaseReadinessClient {
  $queryRawUnsafe(query: string): Promise<unknown>;
}

export async function isDatabaseReady(
  client: DatabaseReadinessClient,
): Promise<boolean> {
  try {
    await client.$queryRawUnsafe('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
