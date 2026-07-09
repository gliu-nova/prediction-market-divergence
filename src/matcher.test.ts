import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchCrossVenue } from "./matcher.ts";
import type { CanonicalMarket } from "./types.ts";

function market(partial: Partial<CanonicalMarket> & Pick<CanonicalMarket, "venue" | "market_id" | "match_key">): CanonicalMarket {
  return {
    canonical_id: partial.match_key,
    title: partial.title ?? "Title",
    topic: partial.topic ?? "General",
    probability: partial.probability ?? 0.5,
    volume: partial.volume ?? 1000,
    liquidity: partial.liquidity ?? 100,
    url: partial.url ?? "https://example.com",
    observed_at: partial.observed_at ?? "2026-07-09T00:00:00.000Z",
    ...partial,
  };
}

describe("matchCrossVenue", () => {
  it("pairs markets that share a match_key across venues", () => {
    const pairs = matchCrossVenue([
      market({ venue: "kalshi", market_id: "k1", match_key: "macro:recession-2026", probability: 0.2 }),
      market({ venue: "polymarket", market_id: "p1", match_key: "macro:recession-2026", probability: 0.3 }),
    ]);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]?.market_a.venue, "kalshi");
    assert.equal(pairs[0]?.market_b.venue, "polymarket");
  });

  it("prefers higher volume when the same venue has duplicate keys", () => {
    const pairs = matchCrossVenue([
      market({ venue: "kalshi", market_id: "k-low", match_key: "btc:100k", volume: 100 }),
      market({ venue: "kalshi", market_id: "k-high", match_key: "btc:100k", volume: 50_000 }),
      market({ venue: "polymarket", market_id: "p1", match_key: "btc:100k", volume: 10_000 }),
    ]);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]?.market_a.market_id, "k-high");
  });

  it("skips keys present on only one venue", () => {
    const pairs = matchCrossVenue([
      market({ venue: "kalshi", market_id: "k1", match_key: "only:kalshi" }),
    ]);
    assert.equal(pairs.length, 0);
  });
});
