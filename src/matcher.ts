import type { CanonicalMarket, MatchedPair } from "./types";

export function matchCrossVenue(markets: CanonicalMarket[]): MatchedPair[] {
  const byKey = new Map<string, Map<string, CanonicalMarket>>();

  for (const market of markets) {
    if (!byKey.has(market.match_key)) byKey.set(market.match_key, new Map());
    byKey.get(market.match_key)!.set(market.venue, market);
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