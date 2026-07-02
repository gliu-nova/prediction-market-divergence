import { upsertMarkets, setJobState } from "../d1/tiered.ts";
import { normalizeRawMarket } from "../normalize.ts";
import { fetchKalshiMarkets, kalshiAuthFromEnv } from "../sources/kalshi.ts";
import { fetchMockMarkets } from "../sources/mock.ts";
import { fetchPolymarketMarkets } from "../sources/polymarket.ts";
import { ensureTables } from "../storage.ts";
import type { CanonicalMarket, Env } from "../types.ts";
import { loadConfig } from "../config.ts";

export interface DiscoverResult {
  markets: number;
  kalshi_markets: number;
  polymarket_markets: number;
}

export async function runDiscoverMarkets(env: Env): Promise<DiscoverResult> {
  const config = loadConfig(env);
  const now = new Date().toISOString();
  await ensureTables(env.DB);

  let kalshiRaw: Record<string, unknown>[] = [];
  let polyRaw: Record<string, unknown>[] = [];

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
    polyRaw = polymarketRaw;
  }

  const markets: CanonicalMarket[] = [];
  for (const raw of [...kalshiRaw, ...polyRaw]) {
    const canonical = normalizeRawMarket(raw, now);
    if (!canonical) continue;
    markets.push(canonical);
  }

  await upsertMarkets(env.DB, markets, now);
  await setJobState(env.DB, "last_discover_at", now);

  const kalshiCount = markets.filter((m) => m.venue === "kalshi").length;
  const polyCount = markets.filter((m) => m.venue === "polymarket").length;

  return {
    markets: markets.length,
    kalshi_markets: kalshiCount,
    polymarket_markets: polyCount,
  };
}