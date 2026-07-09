import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectCrossVenueWithKeys, MAX_OBSERVATION_SKEW_MS } from "./divergence.ts";
import type { AppConfig, MatchedPair } from "./types.ts";

const config: AppConfig = {
  useMock: true,
  minDivergencePctPoints: 5,
  minVolume: 1000,
  lookbackDays: 30,
  opportunityMaxAgeHours: 24,
  observationRetentionDays: 30,
  scoring: {
    weightDifference: 0.4,
    weightLiquidity: 0.25,
    weightRecency: 0.2,
    weightRarity: 0.15,
  },
};

function pair(overrides: {
  volA?: number;
  volB?: number;
  probA?: number;
  probB?: number;
  observedA?: string;
  observedB?: string;
}): MatchedPair {
  return {
    match_key: "fed-rates:fed-cut",
    topic: "Fed rates",
    title: "Fed cut",
    market_a: {
      canonical_id: "fed-rates:fed-cut",
      title: "Fed cut",
      topic: "Fed rates",
      venue: "kalshi",
      market_id: "k1",
      probability: overrides.probA ?? 0.4,
      volume: overrides.volA ?? 5000,
      liquidity: 1000,
      url: "https://kalshi.example/k1",
      observed_at: overrides.observedA ?? "2026-07-09T12:00:00.000Z",
      match_key: "fed-rates:fed-cut",
    },
    market_b: {
      canonical_id: "fed-rates:fed-cut",
      title: "Fed cut?",
      topic: "Fed rates",
      venue: "polymarket",
      market_id: "p1",
      probability: overrides.probB ?? 0.55,
      volume: overrides.volB ?? 8000,
      liquidity: 2000,
      url: "https://poly.example/p1",
      observed_at: overrides.observedB ?? "2026-07-09T12:10:00.000Z",
      match_key: "fed-rates:fed-cut",
    },
  };
}

describe("detectCrossVenueWithKeys", () => {
  it("emits a signal when gap, volume, and skew pass", () => {
    const detected = detectCrossVenueWithKeys(config, [pair({})], new Map([["fed-rates:fed-cut", 10]]));
    assert.equal(detected.length, 1);
    assert.equal(detected[0]?.signal.difference_pct_points, 15);
    assert.match(detected[0]?.signal.lookback_context ?? "", /Largest gap/);
  });

  it("requires both sides to meet minVolume", () => {
    const detected = detectCrossVenueWithKeys(
      config,
      [pair({ volA: 5000, volB: 100 })],
      new Map([["fed-rates:fed-cut", null]]),
    );
    assert.equal(detected.length, 0);
  });

  it("rejects pairs with observation skew beyond the limit", () => {
    const skewMs = MAX_OBSERVATION_SKEW_MS + 60_000;
    const detected = detectCrossVenueWithKeys(
      config,
      [
        pair({
          observedA: "2026-07-09T10:00:00.000Z",
          observedB: new Date(Date.parse("2026-07-09T10:00:00.000Z") + skewMs).toISOString(),
        }),
      ],
      new Map([["fed-rates:fed-cut", null]]),
    );
    assert.equal(detected.length, 0);
  });

  it("uses no-history lookback context when max gap is null", () => {
    const detected = detectCrossVenueWithKeys(config, [pair({})], new Map([["fed-rates:fed-cut", null]]));
    assert.equal(detected[0]?.signal.lookback_context, "No historical gap data yet");
  });
});
