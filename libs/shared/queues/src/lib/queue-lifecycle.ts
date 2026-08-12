export interface ClosableQueue {
  close(): Promise<void>;
}

export async function closeQueue(queue: ClosableQueue): Promise<void> {
  await queue.close();
}
