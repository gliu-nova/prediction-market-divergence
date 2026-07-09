import type { CanonicalMarket, MatchedPair } from "./types";

function marketRank(market: CanonicalMarket): number {
  return Math.max(market.volume ?? 0, 0) + Math.max(market.liquidity ?? 0, 0) * 0.25;
}

/** Prefer the highest volume/liquidity market when a venue has duplicates for a key. */
function pickPreferred(a: CanonicalMarket, b: CanonicalMarket): CanonicalMarket {
  return marketRank(b) > marketRank(a) ? b : a;
}

export function matchCrossVenue(markets: CanonicalMarket[]): MatchedPair[] {
  const byKey = new Map<string, Map<string, CanonicalMarket>>();

  for (const market of markets) {
    if (!byKey.has(market.match_key)) byKey.set(market.match_key, new Map());
    const venueMap = byKey.get(market.match_key)!;
    const existing = venueMap.get(market.venue);
    venueMap.set(market.venue, existing ? pickPreferred(existing, market) : market);
  }

  const pairs: MatchedPair[] = [];
  for (const [matchKey, venueMap] of byKey) {
    if (venueMap.size < 2) continue;
    const venues = [...venueMap.keys()].sort();
    const marketA = venueMap.get(venues[0])!;
    const marketB = venueMap.get(venues[1])!;
    pairs.push({
      match_key: matchKey,
      topic: marketA.topic,
      title: marketA.title,
      market_a: marketA,
      market_b: marketB,
    });
  }
  return pairs;
}
