import { archiveKalshiRawPages, archiveMarketSnapshot } from "../archive/r2.ts";
import { upsertLatestPrices, upsertMarkets, setJobState } from "../d1/tiered.ts";
import { normalizeRawMarket } from "../normalize.ts";
import { fetchKalshiMarkets, kalshiAuthFromEnv } from "../sources/kalshi.ts";
import { fetchMockMarkets } from "../sources/mock.ts";
import { fetchPolymarketMarkets } from "../sources/polymarket.ts";
import { ensureTables, recordIngestStats } from "../storage.ts";
import type { CanonicalMarket, Env } from "../types.ts";
import { loadConfig } from "../config.ts";
import { matchCrossVenue } from "../matcher.ts";

export interface DiscoverResult {
  markets: number;
  kalshi_markets: number;
  polymarket_markets: number;
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

  if (config.useMock) {
    kalshiRaw = fetchMockMarkets("kalshi", now);
    polyRaw = fetchMockMarkets("polymarket", now);
  } else {
    const kalshiAuth = kalshiAuthFromEnv(env);
    const [kalshiIngest, polymarketRaw] = await Promise.all([
      fetchKalshiMarkets(now, { auth: kalshiAuth }),
      fetchPolymarketMarkets(now, { env: env as unknown as Record<string, string | undefined> }),
    ]);
    kalshiRaw = kalshiIngest.markets;
    kalshiPages = kalshiIngest.pages.map((p) => ({ pageIndex: p.pageIndex, payload: p.payload }));
    polyRaw = polymarketRaw;
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
  await recordIngestStats(env.DB, now, {
    markets: markets.length,
    pairs: pairs.length,
    kalshi_markets: kalshiMarkets.length,
    polymarket_markets: polyMarkets.length,
  });
  await setJobState(env.DB, "last_discover_at", now);

  return {
    markets: markets.length,
    kalshi_markets: kalshiMarkets.length,
    polymarket_markets: polyMarkets.length,
    r2_keys: r2Keys,
  };
}
