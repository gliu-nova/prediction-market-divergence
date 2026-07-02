import {
  archiveKalshiRawPages,
  archiveMarketSnapshot,
  archivePolymarketOrderbooks,
} from "../archive/r2.ts";
import { upsertLatestPrices, upsertMarkets, setJobState } from "../d1/tiered.ts";
import { normalizeRawMarket } from "../normalize.ts";
import { fetchKalshiMarkets, kalshiAuthFromEnv } from "../sources/kalshi.ts";
import { fetchMockMarkets } from "../sources/mock.ts";
import { fetchPolymarketSnapshot } from "../sources/polymarket.ts";
import { savePolymarketSnapshotD1 } from "../polymarket/storage-d1.ts";
import { ensureTables, saveIngestedSnapshot } from "../storage.ts";
import type { CanonicalMarket, Env } from "../types.ts";
import { loadConfig } from "../config.ts";
import { matchCrossVenue } from "../matcher.ts";

export interface IngestResult {
  markets: number;
  pairs: number;
  kalshi_markets: number;
  polymarket_markets: number;
  r2_keys: string[];
}

export async function runIngestSnapshots(env: Env): Promise<IngestResult> {
  const config = loadConfig(env);
  const ingestTs = new Date().toISOString();
  await ensureTables(env.DB);

  let kalshiRaw: Record<string, unknown>[] = [];
  let polyRaw: Record<string, unknown>[] = [];
  let kalshiPages: Array<{ pageIndex: number; payload: unknown }> = [];
  let polymarketSnapshot = null;

  if (config.useMock) {
    kalshiRaw = fetchMockMarkets("kalshi", ingestTs);
    polyRaw = fetchMockMarkets("polymarket", ingestTs);
  } else {
    const kalshiAuth = kalshiAuthFromEnv(env);
    const [kalshiIngest, polymarketIngest] = await Promise.all([
      fetchKalshiMarkets(ingestTs, { auth: kalshiAuth }),
      fetchPolymarketSnapshot(ingestTs, {
        env: env as unknown as Record<string, string | undefined>,
        includeOrderBooks: true,
      }),
    ]);
    kalshiRaw = kalshiIngest.markets;
    kalshiPages = kalshiIngest.pages.map((p) => ({ pageIndex: p.pageIndex, payload: p.payload }));
    polymarketSnapshot = polymarketIngest;
    polyRaw = polymarketIngest.legacyRawMarkets;
    await savePolymarketSnapshotD1(env.DB, polymarketIngest);
  }

  const markets: CanonicalMarket[] = [];
  for (const raw of [...kalshiRaw, ...polyRaw]) {
    const canonical = normalizeRawMarket(raw, ingestTs);
    if (!canonical) continue;
    markets.push(canonical);
  }

  const pairs = matchCrossVenue(markets);
  const r2Keys: string[] = [];

  const kalshiMarkets = markets.filter((m) => m.venue === "kalshi");
  const polyMarkets = markets.filter((m) => m.venue === "polymarket");

  const kalshiKey = await archiveMarketSnapshot(env.HISTORY, "kalshi", ingestTs, kalshiMarkets);
  if (kalshiKey) r2Keys.push(kalshiKey);
  if (kalshiPages.length) {
    const rawKey = await archiveKalshiRawPages(env.HISTORY, ingestTs, kalshiPages);
    if (rawKey && !r2Keys.includes(rawKey)) r2Keys.push(rawKey);
  }

  const polyKey = await archiveMarketSnapshot(env.HISTORY, "polymarket", ingestTs, polyMarkets);
  if (polyKey) r2Keys.push(polyKey);
  const obKeys = await archivePolymarketOrderbooks(env.HISTORY, ingestTs, polymarketSnapshot);
  r2Keys.push(...obKeys);

  await upsertMarkets(env.DB, markets, ingestTs);
  await upsertLatestPrices(env.DB, markets, ingestTs);
  await saveIngestedSnapshot(env.DB, ingestTs, markets, pairs);
  await setJobState(env.DB, "last_ingest_at", ingestTs);

  return {
    markets: markets.length,
    pairs: pairs.length,
    kalshi_markets: kalshiMarkets.length,
    polymarket_markets: polyMarkets.length,
    r2_keys: r2Keys,
  };
}