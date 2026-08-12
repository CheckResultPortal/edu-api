export interface ClosableRedisClient {
  readonly status: string;
  disconnect(): void;
  quit(): Promise<unknown>;
}

export async function closeRedisClient(
  client: ClosableRedisClient,
): Promise<void> {
  if (client.status === 'wait' || client.status === 'end') {
    client.disconnect();
    return;
  }

  await client.quit();
}
