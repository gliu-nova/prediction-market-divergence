import { loadConfig } from "./config";
import { detectCrossVenue } from "./divergence";
import { matchCrossVenue } from "./matcher";
import { normalizeRawMarket, toObservation } from "./normalize";
import { fetchKalshiMarkets, kalshiAuthFromEnv } from "./sources/kalshi";
import { fetchMockMarkets } from "./sources/mock";
import { fetchPolymarketMarkets } from "./sources/polymarket";
import {
  maxHistoricalGap,
  pruneObservations,
  recordPollResult,
  saveObservations,
  syncActiveSignals,
} from "./storage";
import type { CanonicalMarket, Env } from "./types";

export interface PollResult {
  markets: number;
  pairs: number;
  opportunities: number;
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
      const [kalshiIngest, polymarketRaw] = await Promise.all([
        fetchKalshiMarkets(pollTs, { auth: kalshiAuth }),
        fetchPolymarketMarkets(pollTs),
      ]);
      kalshiRaw = kalshiIngest.markets;
      polyRaw = polymarketRaw;
    }

    const markets: CanonicalMarket[] = [];
    const observations = [];
    for (const raw of [...kalshiRaw, ...polyRaw]) {
      const canonical = normalizeRawMarket(raw, pollTs);
      if (!canonical) continue;
      markets.push(canonical);
      observations.push(toObservation(canonical));
    }

    await saveObservations(env.DB, observations, 150);
    await pruneObservations(env.DB, config.observationRetentionDays);

    const pairs = matchCrossVenue(markets);
    const maxGapByPair = new Map<string, number | null>();
    for (const pair of pairs) {
      const gap = await maxHistoricalGap(
        env.DB,
        pair.match_key,
        pair.market_a.venue === "kalshi" ? "Kalshi" : "Polymarket",
        pair.market_b.venue === "kalshi" ? "Kalshi" : "Polymarket",
        config.lookbackDays,
        pollTs,
      );
      maxGapByPair.set(pair.match_key, gap);
    }

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