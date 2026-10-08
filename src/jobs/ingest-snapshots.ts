import { archiveMarketSnapshot } from "../archive/r2.ts";
import { loadConfig } from "../config.ts";
import {
  filterMarketsToTracked,
  loadActiveMarketKeys,
  setJobState,
  upsertLatestPricesIfChanged,
  type MarketKey,
} from "../d1/tiered.ts";
import { capByVolume, ingestBudgetFromEnv, type IngestBudget } from "../ingest-budget.ts";
import { matchCrossVenue } from "../matcher.ts";
import { normalizeRawMarket } from "../normalize.ts";
import { fetchMockMarkets } from "../sources/mock.ts";
import { fetchKalshiMarketsBounded, kalshiAuthFromEnv } from "../sources/kalshi.ts";
import { fetchPolymarketIngestRows } from "../sources/polymarket.ts";
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

interface LoadedVenues {
  kalshiMarkets: CanonicalMarket[];
  polyMarkets: CanonicalMarket[];
  kalshiTruncated: boolean;
  polymarketTruncated: boolean;
  polyEnriched: number | null;
  polyStored: number | null;
}

function capNormalized(
  rows: Record<string, unknown>[],
  venue: CanonicalMarket["venue"],
  observedAt: string,
  max: number,
  tracked: Set<MarketKey> | null,
): CanonicalMarket[] {
  const normalized = normalizeAll(rows, observedAt);
  const scoped = tracked ? filterMarketsToTracked(normalized, tracked) : normalized;
  return capVenue(scoped, venue, max);
}

/**
 * Fetch and project one venue at a time. Raw pages and the Polymarket snapshot
 * graph stay in this function so they can be collected before D1 and R2 writes.
 */
async function loadIngestMarkets(
  env: Env,
  budget: IngestBudget,
  observedAt: string,
  useMock: boolean,
  tracked: Set<MarketKey> | null,
): Promise<LoadedVenues> {
  if (useMock) {
    return {
      kalshiMarkets: capNormalized(
        fetchMockMarkets("kalshi", observedAt),
        "kalshi",
        observedAt,
        budget.kalshiMaxMarkets,
        null,
      ),
      polyMarkets: capNormalized(
        fetchMockMarkets("polymarket", observedAt),
        "polymarket",
        observedAt,
        budget.polymarketMaxMarkets,
        null,
      ),
      kalshiTruncated: false,
      polymarketTruncated: false,
      polyEnriched: null,
      polyStored: null,
    };
  }

  let kalshiMarkets: CanonicalMarket[] = [];
  let kalshiTruncated = false;
  {
    const kalshi = await fetchKalshiMarketsBounded(observedAt, {
      auth: kalshiAuthFromEnv(env),
      maxPages: budget.kalshiMaxPages,
      maxMarkets: budget.kalshiMaxMarkets,
    });
    kalshiMarkets = capNormalized(
      kalshi.markets,
      "kalshi",
      observedAt,
      budget.kalshiMaxMarkets,
      tracked,
    );
    kalshiTruncated = kalshi.truncated;
  }

  const poly = await fetchPolymarketIngestRows(observedAt, {
    env: env as unknown as Record<string, string | undefined>,
    maxMarkets: budget.polymarketMaxMarkets,
    includeOrderBooks: false,
  });
  return {
    kalshiMarkets,
    polyMarkets: capNormalized(poly.rows, "polymarket", observedAt, budget.polymarketMaxMarkets, tracked),
    kalshiTruncated,
    polymarketTruncated: poly.truncated,
    polyEnriched: poly.marketsEnriched,
    polyStored: poly.snapshotsStored,
  };
}

/**
 * Price refresh for tracked markets.
 * Discover owns the catalog snapshot and the full R2 archive. This path
 * fetches one Kalshi page, keeps a capped slim set, and archives only prices
 * that changed.
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

  const loaded = await loadIngestMarkets(env, budget, ingestTs, config.useMock, config.useMock ? null : tracked);
  const { kalshiMarkets, polyMarkets } = loaded;
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
      poly_markets_enriched: loaded.polyEnriched,
      poly_snapshots_stored: loaded.polyStored,
    },
    { advanceSnapshotTs: false },
  );
  await setJobState(env.DB, "last_ingest_at", ingestTs);
  await setJobState(env.DB, "last_kalshi_truncated", loaded.kalshiTruncated ? "1" : "0");
  await setJobState(env.DB, "last_polymarket_truncated", loaded.polymarketTruncated ? "1" : "0");

  return {
    markets: scopedMarkets.length,
    pairs: pairs.length,
    kalshi_markets: kalshiMarkets.length,
    polymarket_markets: polyMarkets.length,
    prices_written: priceWrite.written,
    prices_skipped: priceWrite.skipped,
    kalshi_truncated: loaded.kalshiTruncated,
    polymarket_truncated: loaded.polymarketTruncated,
    r2_keys: r2Keys,
  };
}
