export interface ClosableDatabaseClient {
  $disconnect(): Promise<void>;
}

export async function closeDatabaseClient(
  client: ClosableDatabaseClient,
): Promise<void> {
  await client.$disconnect();
}
