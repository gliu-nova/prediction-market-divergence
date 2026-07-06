/** Cloudflare D1 hard limit: https://developers.cloudflare.com/d1/platform/limits/ */
export const D1_MAX_BOUND_PARAMS = 100;

export function d1RowsPerStatement(paramsPerRow: number, reservedParams = 0): number {
  if (paramsPerRow <= 0) throw new Error("paramsPerRow must be positive");
  return Math.max(1, Math.floor((D1_MAX_BOUND_PARAMS - reservedParams) / paramsPerRow));
}

export function* chunkArray<T>(items: readonly T[], chunkSize: number): Generator<T[], void> {
  const size = Math.max(1, chunkSize);
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

export async function runD1StatementBatches(
  db: D1Database,
  statements: D1PreparedStatement[],
  batchSize = 40,
): Promise<void> {
  for (let i = 0; i < statements.length; i += batchSize) {
    await db.batch(statements.slice(i, i + batchSize));
  }
}
