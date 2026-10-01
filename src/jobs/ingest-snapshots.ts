import { archiveMarketSnapshot } from "../archive/r2.ts";
import { loadConfig } from "../config.ts";
import {
  filterMarketsToTracked,
  loadActiveMarketKeys,
  setJobState,
  upsertLatestPricesIfChanged,
} from "../d1/tiered.ts";
import { capByVolume, ingestBudgetFromEnv, slimPolymarketRaw } from "../ingest-budget.ts";
import { matchCrossVenue } from "../matcher.ts";
import { normalizeRawMarket } from "../normalize.ts";
import { fetchMockMarkets } from "../sources/mock.ts";
import { fetchKalshiMarketsBounded, kalshiAuthFromEnv } from "../sources/kalshi.ts";
import { fetchPolymarketSnapshot } from "../sources/polymarket.ts";
import {
  ensureTables,
  getLastIngestionPollTs,
  recordIngestStats,
  replaceIngestedVenueSnapshot,
} from "../storage.ts";
import type { CanonicalMarket, Env } from "../types.ts";

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

function capVenue(markets: CanonicalMarket[], venue: CanonicalMarket["venue"], max: number): CanonicalMarket[] {
  return capByVolume(
    markets.filter((market) => market.venue === venue),
    max,
    (market) => market.volume ?? 0,
  );
}

function normalizeAll(rows: Record<string, unknown>[], observedAt: string): CanonicalMarket[] {
  const markets: CanonicalMarket[] = [];
  for (const raw of rows) {
    const canonical = normalizeRawMarket(raw, observedAt);
    if (canonical) markets.push(canonical);
  }
  return markets;
}

/**
 * Price refresh for tracked markets.
 * Discover owns the catalog snapshot and the full R2 archive. This path
 * fetches one Kalshi page at a time, keeps a capped slim set, and archives
 * only prices that changed.
 */
export async function runIngestSnapshots(env: Env): Promise<IngestResult> {
  const config = loadConfig(env);
  const budget = ingestBudgetFromEnv(env);
  const ingestTs = new Date().toISOString();
  const previousPollTs = await getLastIngestionPollTs(env.DB);
  await ensureTables(env.DB);

  const tracked = await loadActiveMarketKeys(env.DB);
  if (!config.useMock && tracked.size === 0) {
    throw new Error("No tracked markets in D1; run POST /jobs/discover first");
  }

  let kalshiRaw: Record<string, unknown>[] = [];
  let polyRaw: Record<string, unknown>[] = [];
  let kalshiTruncated = false;
  let polymarketTruncated = false;
  let polyEnriched: number | null = null;
  let polyStored: number | null = null;

  if (config.useMock) {
    kalshiRaw = fetchMockMarkets("kalshi", ingestTs);
    polyRaw = fetchMockMarkets("polymarket", ingestTs);
  } else {
    // One venue at a time so the two upstream payloads are not live together.
    const kalshi = await fetchKalshiMarketsBounded(ingestTs, {
      auth: kalshiAuthFromEnv(env),
      maxPages: budget.kalshiMaxPages,
      maxMarkets: budget.kalshiMaxMarkets,
    });
    kalshiRaw = kalshi.markets;
    kalshiTruncated = kalshi.truncated;

    const polySnap = await fetchPolymarketSnapshot(ingestTs, {
      env: env as unknown as Record<string, string | undefined>,
      maxMarkets: budget.polymarketMaxMarkets,
      includeOrderBooks: false,
    });
    polyRaw = polySnap.legacyRawMarkets.map(slimPolymarketRaw);
    polymarketTruncated = Boolean(polySnap.truncated);
    polyEnriched = polySnap.run.marketsEnriched;
    polyStored = polySnap.run.snapshotsStored;
  }

  const scoped = config.useMock
    ? normalizeAll([...kalshiRaw, ...polyRaw], ingestTs)
    : filterMarketsToTracked(normalizeAll([...kalshiRaw, ...polyRaw], ingestTs), tracked);
  const kalshiMarkets = capVenue(scoped, "kalshi", budget.kalshiMaxMarkets);
  const polyMarkets = capVenue(scoped, "polymarket", budget.polymarketMaxMarkets);
  const scopedMarkets = [...kalshiMarkets, ...polyMarkets];
  const pairs = matchCrossVenue(scopedMarkets);
  const r2Keys: string[] = [];

  const priceWrite = await upsertLatestPricesIfChanged(env.DB, scopedMarkets, ingestTs);
  const kalshiKey = await archiveMarketSnapshot(
    env.HISTORY,
    "kalshi",
    ingestTs,
    priceWrite.changed.filter((market) => market.venue === "kalshi"),
  );
  if (kalshiKey) r2Keys.push(kalshiKey);
  const polyKey = await archiveMarketSnapshot(
    env.HISTORY,
    "polymarket",
    ingestTs,
    priceWrite.changed.filter((market) => market.venue === "polymarket"),
  );
  if (polyKey) r2Keys.push(polyKey);

  if (previousPollTs && kalshiMarkets.length) {
    await replaceIngestedVenueSnapshot(env.DB, previousPollTs, "kalshi", kalshiMarkets);
  }
  if (previousPollTs && polyMarkets.length) {
    await replaceIngestedVenueSnapshot(env.DB, previousPollTs, "polymarket", polyMarkets);
  }

  await recordIngestStats(
    env.DB,
    ingestTs,
    {
      pairs: pairs.length,
      kalshi_markets: kalshiMarkets.length,
      polymarket_markets: polyMarkets.length,
      prices_written: priceWrite.written,
      poly_markets_enriched: polyEnriched,
      poly_snapshots_stored: polyStored,
    },
    { advanceSnapshotTs: false },
  );
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
