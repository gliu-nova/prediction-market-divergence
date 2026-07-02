import { archiveMarketSnapshot } from "../archive/r2.ts";
import {
  filterMarketsToTracked,
  loadActiveMarketKeys,
  upsertLatestPricesIfChanged,
  setJobState,
} from "../d1/tiered.ts";
import { normalizeRawMarket } from "../normalize.ts";
import { fetchMockMarkets } from "../sources/mock.ts";
import { fetchPolymarketSnapshot } from "../sources/polymarket.ts";
import { ensureTables, recordIngestStats } from "../storage.ts";
import type { CanonicalMarket, Env } from "../types.ts";
import { loadConfig } from "../config.ts";
import { matchCrossVenue } from "../matcher.ts";

export interface IngestResult {
  markets: number;
  pairs: number;
  kalshi_markets: number;
  polymarket_markets: number;
  prices_written: number;
  prices_skipped: number;
  r2_keys: string[];
}

/**
 * Lightweight 15m price refresh: Polymarket only.
 * Full Kalshi catalog + prices are updated by POST /jobs/discover (4h).
 */
export async function runIngestSnapshots(env: Env): Promise<IngestResult> {
  const config = loadConfig(env);
  const ingestTs = new Date().toISOString();
  await ensureTables(env.DB);

  const tracked = await loadActiveMarketKeys(env.DB);
  if (!config.useMock && tracked.size === 0) {
    throw new Error("No tracked markets in D1; run POST /jobs/discover first");
  }

  let polyRaw: Record<string, unknown>[] = [];
  let polymarketSnapshot = null;

  if (config.useMock) {
    polyRaw = fetchMockMarkets("polymarket", ingestTs);
  } else {
    polymarketSnapshot = await fetchPolymarketSnapshot(ingestTs, {
      env: env as unknown as Record<string, string | undefined>,
      includeOrderBooks: false,
    });
    polyRaw = polymarketSnapshot.legacyRawMarkets;
  }

  const markets: CanonicalMarket[] = [];
  for (const raw of polyRaw) {
    const canonical = normalizeRawMarket(raw, ingestTs);
    if (!canonical) continue;
    markets.push(canonical);
  }

  const scopedMarkets = config.useMock ? markets : filterMarketsToTracked(markets, tracked);
  const pairs = matchCrossVenue(scopedMarkets);
  const r2Keys: string[] = [];

  const polyMarkets = scopedMarkets.filter((m) => m.venue === "polymarket");

  const polyKey = await archiveMarketSnapshot(env.HISTORY, "polymarket", ingestTs, polyMarkets);
  if (polyKey) r2Keys.push(polyKey);

  const priceWrite = await upsertLatestPricesIfChanged(env.DB, scopedMarkets, ingestTs);
  await recordIngestStats(env.DB, ingestTs, {
    pairs: pairs.length,
    polymarket_markets: polyMarkets.length,
    prices_written: priceWrite.written,
    poly_markets_enriched: polymarketSnapshot?.run.marketsEnriched ?? null,
    poly_snapshots_stored: polymarketSnapshot?.run.snapshotsStored ?? null,
  });
  await setJobState(env.DB, "last_ingest_at", ingestTs);

  return {
    markets: scopedMarkets.length,
    pairs: pairs.length,
    kalshi_markets: 0,
    polymarket_markets: polyMarkets.length,
    prices_written: priceWrite.written,
    prices_skipped: priceWrite.skipped,
    r2_keys: r2Keys,
  };
}
