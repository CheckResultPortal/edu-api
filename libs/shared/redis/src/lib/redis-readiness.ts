export interface RedisReadinessClient {
  connect?(): Promise<unknown>;
  ping(): Promise<string>;
  readonly status?: string;
}

export async function isRedisReady(
  client: RedisReadinessClient,
): Promise<boolean> {
  try {
    if (client.status === 'wait' && client.connect) {
      await client.connect();
    }

    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  }
}
