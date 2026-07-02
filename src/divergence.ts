import { scoreDivergence } from "./scoring";
import type { AppConfig, MatchedPair, Signal } from "./types";

function lookbackContext(config: AppConfig, diffPp: number, maxGap: number | null): string {
  if (maxGap == null) return "First cross-venue observation";
  if (diffPp > maxGap) return `Largest gap in ${config.lookbackDays} days`;
  return `Within ${config.lookbackDays}-day range (max ${maxGap.toFixed(1)} pp)`;
}

function signalId(pair: MatchedPair): string {
  const keySlug = pair.match_key.replace(/:/g, "_").replace(/-/g, "_").slice(0, 60);
  return `kalshi_polymarket_${keySlug}`;
}

function headline(topic: string): string {
  return `${topic.toUpperCase()} ODDS DIVERGE`;
}

function venueLabel(venue: "kalshi" | "polymarket"): string {
  return venue === "kalshi" ? "Kalshi" : "Polymarket";
}

export interface DetectedSignal {
  signal: Signal;
  match_key: string;
}

export function detectCrossVenueWithKeys(
  config: AppConfig,
  pairs: MatchedPair[],
  maxGapByPair: Map<string, number | null>,
): DetectedSignal[] {
  const now = new Date().toISOString();
  const results: DetectedSignal[] = [];

  for (const pair of pairs) {
    const diffPp = Math.abs(pair.market_a.probability - pair.market_b.probability) * 100;
    if (diffPp < config.minDivergencePctPoints) continue;

    const volA = pair.market_a.volume ?? 0;
    const volB = pair.market_b.volume ?? 0;
    if (Math.max(volA, volB) < config.minVolume) continue;

    const maxGap = maxGapByPair.get(pair.match_key) ?? null;
    const observedAt =
      pair.market_a.observed_at > pair.market_b.observed_at
        ? pair.market_a.observed_at
        : pair.market_b.observed_at;

    const score = scoreDivergence(config, diffPp, pair.market_a, pair.market_b, maxGap, observedAt);

    results.push({
      match_key: pair.match_key,
      signal: {
        id: signalId(pair),
        type: "prediction_market_divergence",
        title: headline(pair.topic),
        asset_or_topic: pair.topic,
        market_a: {
          venue: venueLabel(pair.market_a.venue),
          probability: Math.round(pair.market_a.probability * 10000) / 10000,
          url: pair.market_a.url,
          market_id: pair.market_a.market_id,
          volume: pair.market_a.volume,
          liquidity: pair.market_a.liquidity,
        },
        market_b: {
          venue: venueLabel(pair.market_b.venue),
          probability: Math.round(pair.market_b.probability * 10000) / 10000,
          url: pair.market_b.url,
          market_id: pair.market_b.market_id,
          volume: pair.market_b.volume,
          liquidity: pair.market_b.liquidity,
        },
        difference_pct_points: Math.round(diffPp * 10) / 10,
        implied_arb_profit_pct: Math.round(diffPp * 10) / 10,
        lookback_context: lookbackContext(config, diffPp, maxGap),
        score,
        created_at: now,
        tweet_hint: `${venueLabel(pair.market_a.venue)} and ${venueLabel(pair.market_b.venue)} disagree by ${diffPp.toFixed(0)} pts on ${pair.topic.toLowerCase()} odds.`,
        is_active: true,
      },
    });
  }

  return results;
}

export function detectCrossVenue(
  config: AppConfig,
  pairs: MatchedPair[],
  maxGapByPair: Map<string, number | null>,
): Signal[] {
  return detectCrossVenueWithKeys(config, pairs, maxGapByPair).map((r) => r.signal);
}