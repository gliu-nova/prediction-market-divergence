import {
  archiveKalshiRawPages,
  archiveMarketSnapshot,
  archivePolymarketOrderbooks,
} from "../archive/r2.ts";
import { upsertLatestPricesIfChanged, setJobState } from "../d1/tiered.ts";
import { normalizeRawMarket } from "../normalize.ts";
import { fetchKalshiMarkets, kalshiAuthFromEnv } from "../sources/kalshi.ts";
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

  const priceWrite = await upsertLatestPricesIfChanged(env.DB, markets, ingestTs);
  await recordIngestStats(env.DB, ingestTs, {
    markets: markets.length,
    pairs: pairs.length,
    kalshi_markets: kalshiMarkets.length,
    polymarket_markets: polyMarkets.length,
    prices_written: priceWrite.written,
    poly_markets_enriched: polymarketSnapshot?.run.marketsEnriched ?? null,
    poly_snapshots_stored: polymarketSnapshot?.run.snapshotsStored ?? null,
  });
  await setJobState(env.DB, "last_ingest_at", ingestTs);

  return {
    markets: markets.length,
    pairs: pairs.length,
    kalshi_markets: kalshiMarkets.length,
    polymarket_markets: polyMarkets.length,
    prices_written: priceWrite.written,
    prices_skipped: priceWrite.skipped,
    r2_keys: r2Keys,
  };
}