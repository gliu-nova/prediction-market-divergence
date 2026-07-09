import { archiveMarketSnapshot } from "../archive/r2.ts";
import {
  filterMarketsToTracked,
  loadActiveMarketKeys,
  upsertLatestPricesIfChanged,
  setJobState,
} from "../d1/tiered.ts";
import { normalizeRawMarket } from "../normalize.ts";
import { fetchKalshiMarkets, kalshiAuthFromEnv } from "../sources/kalshi.ts";
import { fetchMockMarkets } from "../sources/mock.ts";
import { fetchPolymarketSnapshot } from "../sources/polymarket.ts";
import {
  ensureTables,
  getLastIngestionPollTs,
  recordIngestStats,
  saveIngestedPolymarketSnapshot,
} from "../storage.ts";
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
  kalshi_truncated: boolean;
  polymarket_truncated: boolean;
  r2_keys: string[];
}

/**
 * Lightweight price refresh for tracked markets (both venues).
 * Full catalog metadata (activate/deactivate) remains on POST /jobs/discover.
 */
export async function runIngestSnapshots(env: Env): Promise<IngestResult> {
  const config = loadConfig(env);
  const ingestTs = new Date().toISOString();
  const previousPollTs = await getLastIngestionPollTs(env.DB);
  await ensureTables(env.DB);

  const tracked = await loadActiveMarketKeys(env.DB);
  if (!config.useMock && tracked.size === 0) {
    throw new Error("No tracked markets in D1; run POST /jobs/discover first");
  }

  let kalshiRaw: Record<string, unknown>[] = [];
  let polyRaw: Record<string, unknown>[] = [];
  let polymarketSnapshot = null;
  let kalshiTruncated = false;
  let polymarketTruncated = false;

  if (config.useMock) {
    kalshiRaw = fetchMockMarkets("kalshi", ingestTs);
    polyRaw = fetchMockMarkets("polymarket", ingestTs);
  } else {
    const kalshiAuth = kalshiAuthFromEnv(env);
    const [kalshiIngest, polySnap] = await Promise.all([
      fetchKalshiMarkets(ingestTs, { auth: kalshiAuth }),
      fetchPolymarketSnapshot(ingestTs, {
        env: env as unknown as Record<string, string | undefined>,
        includeOrderBooks: false,
      }),
    ]);
    kalshiRaw = kalshiIngest.markets;
    kalshiTruncated = kalshiIngest.truncated;
    polymarketSnapshot = polySnap;
    polyRaw = polySnap.legacyRawMarkets;
    polymarketTruncated = Boolean(polySnap.truncated);
  }

  const markets: CanonicalMarket[] = [];
  for (const raw of [...kalshiRaw, ...polyRaw]) {
    const canonical = normalizeRawMarket(raw, ingestTs);
    if (!canonical) continue;
    markets.push(canonical);
  }

  const scopedMarkets = config.useMock ? markets : filterMarketsToTracked(markets, tracked);
  const pairs = matchCrossVenue(scopedMarkets);
  const r2Keys: string[] = [];

  const kalshiMarkets = scopedMarkets.filter((m) => m.venue === "kalshi");
  const polyMarkets = scopedMarkets.filter((m) => m.venue === "polymarket");

  const kalshiKey = await archiveMarketSnapshot(env.HISTORY, "kalshi", ingestTs, kalshiMarkets);
  if (kalshiKey) r2Keys.push(kalshiKey);
  const polyKey = await archiveMarketSnapshot(env.HISTORY, "polymarket", ingestTs, polyMarkets);
  if (polyKey) r2Keys.push(polyKey);

  const priceWrite = await upsertLatestPricesIfChanged(env.DB, scopedMarkets, ingestTs);
  await saveIngestedPolymarketSnapshot(env.DB, ingestTs, polyMarkets, previousPollTs);
  await recordIngestStats(env.DB, ingestTs, {
    pairs: pairs.length,
    kalshi_markets: kalshiMarkets.length,
    polymarket_markets: polyMarkets.length,
    prices_written: priceWrite.written,
    poly_markets_enriched: polymarketSnapshot?.run.marketsEnriched ?? null,
    poly_snapshots_stored: polymarketSnapshot?.run.snapshotsStored ?? null,
  });
  await setJobState(env.DB, "last_ingest_at", ingestTs);
  await setJobState(env.DB, "last_kalshi_truncated", kalshiTruncated ? "1" : "0");
  await setJobState(env.DB, "last_polymarket_truncated", polymarketTruncated ? "1" : "0");

  return {
    markets: scopedMarkets.length,
    pairs: pairs.length,
    kalshi_markets: kalshiMarkets.length,
    polymarket_markets: polyMarkets.length,
    prices_written: priceWrite.written,
    prices_skipped: priceWrite.skipped,
    kalshi_truncated: kalshiTruncated,
    polymarket_truncated: polymarketTruncated,
    r2_keys: r2Keys,
  };
}
