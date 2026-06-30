import { polymarketConfigFromEnv } from "../polymarket/config.ts";
import { runPolymarketSnapshot } from "../polymarket/snapshot.ts";
import type { PolymarketSnapshotResult } from "../polymarket/types.ts";

export interface PolymarketFetchOptions {
  env?: Record<string, string | undefined>;
  activeOnly?: boolean;
  limit?: number;
  maxMarkets?: number;
  includeOrderBooks?: boolean;
  includeTrades?: boolean;
}

export async function fetchPolymarketSnapshot(
  fetchedAt: string,
  options: PolymarketFetchOptions = {},
): Promise<PolymarketSnapshotResult> {
  const config = polymarketConfigFromEnv(options.env);
  const result = await runPolymarketSnapshot(config, {
    activeOnly: options.activeOnly ?? true,
    limit: options.limit,
    maxMarkets: options.maxMarkets ?? config.discoveryMaxMarkets,
    includeOrderBooks: options.includeOrderBooks ?? false,
    includeTrades: options.includeTrades ?? false,
    mode: "poll",
  });

  return {
    ...result,
    legacyRawMarkets: result.legacyRawMarkets.map((row) => ({ ...row, fetched_at: fetchedAt })),
  };
}

/** Backward-compatible adapter used by the poll pipeline. */
export async function fetchPolymarketMarkets(
  fetchedAt: string,
  options: PolymarketFetchOptions = {},
): Promise<Record<string, unknown>[]> {
  const snapshot = await fetchPolymarketSnapshot(fetchedAt, options);
  return snapshot.legacyRawMarkets;
}

export async function polymarketHealthy(): Promise<boolean> {
  try {
    const config = polymarketConfigFromEnv();
    const resp = await fetch(`${config.endpoints.gammaBaseUrl}/markets?limit=1&active=true`);
    return resp.ok;
  } catch {
    return false;
  }
}