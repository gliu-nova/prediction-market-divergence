import { archiveDetectSnapshot } from "../archive/r2.ts";
import { loadLatestPricesMarkets, maxGapsFromIndicators, recordOpportunityEvents, setJobState } from "../d1/tiered.ts";
import { loadConfig } from "../config.ts";
import { detectCrossVenueWithKeys } from "../divergence.ts";
import { matchCrossVenue } from "../matcher.ts";
import { ensureTables, maxHistoricalGapsForPairs, recordPollResult, syncActiveSignals } from "../storage.ts";
import type { Env } from "../types.ts";

export interface DetectResult {
  markets: number;
  pairs: number;
  opportunities: number;
}

export async function runDetectOpportunities(env: Env): Promise<DetectResult> {
  const config = loadConfig(env);
  const detectTs = new Date().toISOString();
  await ensureTables(env.DB);

  const markets = await loadLatestPricesMarkets(env.DB);
  const pairs = matchCrossVenue(markets);

  let maxGapByPair = await maxGapsFromIndicators(env.DB, pairs);
  const needsFallback = [...maxGapByPair.values()].every((v) => v == null);
  if (needsFallback && pairs.length) {
    maxGapByPair = await maxHistoricalGapsForPairs(env.DB, pairs, config.lookbackDays, detectTs);
  }

  const detected = detectCrossVenueWithKeys(config, pairs, maxGapByPair);
  const signals = detected.map((d) => d.signal);
  await syncActiveSignals(env.DB, signals);
  await recordOpportunityEvents(env.DB, detected);
  await archiveDetectSnapshot(env.HISTORY, detectTs, pairs, signals.length);
  await setJobState(env.DB, "last_detect_at", detectTs);

  const kalshiMarkets = markets.filter((m) => m.venue === "kalshi").length;
  const polymarketMarkets = markets.filter((m) => m.venue === "polymarket").length;

  await recordPollResult(env.DB, {
    markets: markets.length,
    pairs: pairs.length,
    opportunities: signals.length,
    kalshi_markets: kalshiMarkets,
    polymarket_markets: polymarketMarkets,
  });

  return {
    markets: markets.length,
    pairs: pairs.length,
    opportunities: signals.length,
  };
}