import { archiveMarketSnapshot } from "../archive/r2.ts";
import { loadConfig } from "../config.ts";
import { deactivateMarketsNotInSet, setJobState, upsertLatestPrices, upsertMarkets } from "../d1/tiered.ts";
import { capByVolume, ingestBudgetFromEnv, slimPolymarketRaw } from "../ingest-budget.ts";
import { matchCrossVenue } from "../matcher.ts";
import { normalizeRawMarket } from "../normalize.ts";
import { fetchMockMarkets } from "../sources/mock.ts";
import { fetchKalshiMarketsBounded, kalshiAuthFromEnv } from "../sources/kalshi.ts";
import { fetchPolymarketSnapshot } from "../sources/polymarket.ts";
import { ensureTables, recordIngestStats, saveIngestedMarketsSnapshot } from "../storage.ts";
import type { CanonicalMarket, Env } from "../types.ts";

export interface DiscoverResult {
  markets: number;
  kalshi_markets: number;
  polymarket_markets: number;
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

/** Capped catalog refresh. Raw Kalshi pages are not archived or retained. */
export async function runDiscoverMarkets(env: Env): Promise<DiscoverResult> {
  const config = loadConfig(env);
  const budget = ingestBudgetFromEnv(env);
  const now = new Date().toISOString();
  await ensureTables(env.DB);

  let kalshiRaw: Record<string, unknown>[] = [];
  let polyRaw: Record<string, unknown>[] = [];
  let kalshiTruncated = false;
  let polymarketTruncated = false;

  if (config.useMock) {
    kalshiRaw = fetchMockMarkets("kalshi", now);
    polyRaw = fetchMockMarkets("polymarket", now);
  } else {
    const kalshi = await fetchKalshiMarketsBounded(now, {
      auth: kalshiAuthFromEnv(env),
      maxPages: budget.kalshiMaxPages,
      maxMarkets: budget.kalshiMaxMarkets,
    });
    kalshiRaw = kalshi.markets;
    kalshiTruncated = kalshi.truncated;

    const polySnap = await fetchPolymarketSnapshot(now, {
      env: env as unknown as Record<string, string | undefined>,
      maxMarkets: budget.polymarketMaxMarkets,
      includeOrderBooks: false,
    });
    polyRaw = polySnap.legacyRawMarkets.map(slimPolymarketRaw);
    polymarketTruncated = Boolean(polySnap.truncated);
  }

  const kalshiMarkets = capVenue(normalizeAll(kalshiRaw, now), "kalshi", budget.kalshiMaxMarkets);
  const polyMarkets = capVenue(normalizeAll(polyRaw, now), "polymarket", budget.polymarketMaxMarkets);
  const markets = [...kalshiMarkets, ...polyMarkets];
  const pairs = matchCrossVenue(markets);
  const r2Keys: string[] = [];

  const kalshiKey = await archiveMarketSnapshot(env.HISTORY, "kalshi", now, kalshiMarkets);
  if (kalshiKey) r2Keys.push(kalshiKey);
  const polyKey = await archiveMarketSnapshot(env.HISTORY, "polymarket", now, polyMarkets);
  if (polyKey) r2Keys.push(polyKey);

  await upsertMarkets(env.DB, markets, now);
  await upsertLatestPrices(env.DB, markets, now);
  await saveIngestedMarketsSnapshot(env.DB, now, markets);
  await deactivateMarketsNotInSet(env.DB, "kalshi", new Set(kalshiMarkets.map((m) => m.market_id)), now);
  await deactivateMarketsNotInSet(env.DB, "polymarket", new Set(polyMarkets.map((m) => m.market_id)), now);
  await recordIngestStats(env.DB, now, {
    markets: markets.length,
    pairs: pairs.length,
    kalshi_markets: kalshiMarkets.length,
    polymarket_markets: polyMarkets.length,
  });
  await setJobState(env.DB, "last_discover_at", now);
  await setJobState(env.DB, "last_kalshi_truncated", kalshiTruncated ? "1" : "0");
  await setJobState(env.DB, "last_polymarket_truncated", polymarketTruncated ? "1" : "0");

  return {
    markets: markets.length,
    kalshi_markets: kalshiMarkets.length,
    polymarket_markets: polyMarkets.length,
    kalshi_truncated: kalshiTruncated,
    polymarket_truncated: polymarketTruncated,
    r2_keys: r2Keys,
  };
}
