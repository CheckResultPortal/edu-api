export interface ClosableResource {
  close(): Promise<void>;
}

export async function closeResources(
  resources: readonly ClosableResource[],
): Promise<void> {
  for (const resource of [...resources].reverse()) {
    await resource.close();
  }
}
