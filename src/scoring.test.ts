import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreDivergence } from "./scoring.ts";
import type { AppConfig, CanonicalMarket } from "./types.ts";

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

const market: CanonicalMarket = {
  canonical_id: "x",
  title: "t",
  topic: "General",
  venue: "kalshi",
  market_id: "k",
  probability: 0.5,
  volume: 10_000,
  liquidity: 1000,
  url: "https://example.com",
  observed_at: new Date().toISOString(),
  match_key: "x",
};

describe("scoreDivergence", () => {
  it("scores within 0..100", () => {
    const score = scoreDivergence(config, 12, market, market, null, market.observed_at);
    assert.ok(score >= 0 && score <= 100);
  });

  it("raises rarity when current gap exceeds historical max", () => {
    const withHistory = scoreDivergence(config, 20, market, market, 10, market.observed_at);
    const without = scoreDivergence(config, 20, market, market, null, market.observed_at);
    assert.ok(withHistory >= without);
  });
});
