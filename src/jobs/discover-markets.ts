import { archiveKalshiRawPages, archiveMarketSnapshot } from "../archive/r2.ts";
import { deactivateMarketsNotInSet, upsertLatestPrices, upsertMarkets, setJobState } from "../d1/tiered.ts";
import { normalizeRawMarket } from "../normalize.ts";
import { fetchKalshiMarkets, kalshiAuthFromEnv } from "../sources/kalshi.ts";
import { fetchMockMarkets } from "../sources/mock.ts";
import { fetchPolymarketSnapshot } from "../sources/polymarket.ts";
import { ensureTables, recordIngestStats, saveIngestedMarketsSnapshot } from "../storage.ts";
import type { CanonicalMarket, Env } from "../types.ts";
import { loadConfig } from "../config.ts";
import { matchCrossVenue } from "../matcher.ts";

export interface DiscoverResult {
  markets: number;
  kalshi_markets: number;
  polymarket_markets: number;
  kalshi_truncated: boolean;
  polymarket_truncated: boolean;
  r2_keys: string[];
}

/** Full catalog refresh (4h): both venues, D1 markets + latest_prices, R2 archives. */
export async function runDiscoverMarkets(env: Env): Promise<DiscoverResult> {
  const config = loadConfig(env);
  const now = new Date().toISOString();
  await ensureTables(env.DB);

  let kalshiRaw: Record<string, unknown>[] = [];
  let polyRaw: Record<string, unknown>[] = [];
  let kalshiPages: Array<{ pageIndex: number; payload: unknown }> = [];
  let kalshiTruncated = false;
  let polymarketTruncated = false;

  if (config.useMock) {
    kalshiRaw = fetchMockMarkets("kalshi", now);
    polyRaw = fetchMockMarkets("polymarket", now);
  } else {
    const kalshiAuth = kalshiAuthFromEnv(env);
    const [kalshiIngest, polySnap] = await Promise.all([
      fetchKalshiMarkets(now, { auth: kalshiAuth }),
      fetchPolymarketSnapshot(now, { env: env as unknown as Record<string, string | undefined> }),
    ]);
    kalshiRaw = kalshiIngest.markets;
    kalshiPages = kalshiIngest.pages.map((p) => ({ pageIndex: p.pageIndex, payload: p.payload }));
    kalshiTruncated = kalshiIngest.truncated;
    polyRaw = polySnap.legacyRawMarkets;
    polymarketTruncated = Boolean(polySnap.truncated);
  }

  const markets: CanonicalMarket[] = [];
  for (const raw of [...kalshiRaw, ...polyRaw]) {
    const canonical = normalizeRawMarket(raw, now);
    if (!canonical) continue;
    markets.push(canonical);
  }

  const pairs = matchCrossVenue(markets);
  const kalshiMarkets = markets.filter((m) => m.venue === "kalshi");
  const polyMarkets = markets.filter((m) => m.venue === "polymarket");
  const r2Keys: string[] = [];

  const kalshiKey = await archiveMarketSnapshot(env.HISTORY, "kalshi", now, kalshiMarkets);
  if (kalshiKey) r2Keys.push(kalshiKey);
  if (kalshiPages.length) {
    const rawKey = await archiveKalshiRawPages(env.HISTORY, now, kalshiPages);
    if (rawKey && !r2Keys.includes(rawKey)) r2Keys.push(rawKey);
  }
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
