/**
 * Maps over items with a bounded number in flight.
 *
 * The pipeline's slowest stage was 25 embeddings awaited one at a time — each
 * an S3 fetch plus a Bedrock call, almost all of it waiting on the network.
 * A cap rather than Promise.all, so a long reel cannot fan out into hundreds
 * of simultaneous calls and start getting throttled.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}
