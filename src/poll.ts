import { loadConfig } from "./config";
import { detectCrossVenue } from "./divergence";
import { matchCrossVenue } from "./matcher";
import { normalizeRawMarket, toObservation } from "./normalize";
import { fetchKalshiMarkets, kalshiAuthFromEnv } from "./sources/kalshi";
import { fetchMockMarkets } from "./sources/mock";
import { savePolymarketSnapshotD1 } from "./polymarket/storage-d1";
import { fetchPolymarketSnapshot } from "./sources/polymarket";
import {
  maxHistoricalGapsForPairs,
  pruneObservations,
  recordPollResult,
  saveObservationsBatched,
  syncActiveSignals,
} from "./storage";
import type { CanonicalMarket, Env, MarketObservation, MatchedPair } from "./types";

export interface PollResult {
  markets: number;
  pairs: number;
  opportunities: number;
}

function observationsForPairs(pairs: MatchedPair[]): MarketObservation[] {
  const seen = new Set<string>();
  const observations: MarketObservation[] = [];

  for (const pair of pairs) {
    for (const market of [pair.market_a, pair.market_b]) {
      const key = `${market.venue}:${market.market_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      observations.push(toObservation(market));
    }
  }

  return observations;
}

export async function runPoll(env: Env): Promise<PollResult> {
  const config = loadConfig(env);
  const pollTs = new Date().toISOString();

  try {
    let kalshiRaw: Record<string, unknown>[] = [];
    let polyRaw: Record<string, unknown>[] = [];

    if (config.useMock) {
      kalshiRaw = fetchMockMarkets("kalshi", pollTs);
      polyRaw = fetchMockMarkets("polymarket", pollTs);
    } else {
      const kalshiAuth = kalshiAuthFromEnv(env);
      const [kalshiIngest, polymarketIngest] = await Promise.all([
        fetchKalshiMarkets(pollTs, { auth: kalshiAuth }),
        fetchPolymarketSnapshot(pollTs, { env: env as unknown as Record<string, string | undefined> }),
      ]);
      kalshiRaw = kalshiIngest.markets;
      polyRaw = polymarketIngest.legacyRawMarkets;
      await savePolymarketSnapshotD1(env.DB, polymarketIngest);
    }

    const markets: CanonicalMarket[] = [];
    for (const raw of [...kalshiRaw, ...polyRaw]) {
      const canonical = normalizeRawMarket(raw, pollTs);
      if (!canonical) continue;
      markets.push(canonical);
    }

    const pairs = matchCrossVenue(markets);
    await saveObservationsBatched(env.DB, observationsForPairs(pairs));
    await pruneObservations(env.DB, config.observationRetentionDays);

    const maxGapByPair = await maxHistoricalGapsForPairs(env.DB, pairs, config.lookbackDays, pollTs);

    const signals = detectCrossVenue(config, pairs, maxGapByPair);
    await syncActiveSignals(env.DB, signals);
    await recordPollResult(env.DB, {
      markets: markets.length,
      pairs: pairs.length,
      opportunities: signals.length,
    });

    return { markets: markets.length, pairs: pairs.length, opportunities: signals.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordPollResult(env.DB, { markets: 0, pairs: 0, opportunities: 0, error: message });
    throw err;
  }
}
