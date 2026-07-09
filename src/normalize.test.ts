import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMatchKey, normalizeRawMarket } from "./normalize.ts";

describe("buildMatchKey", () => {
  it("aligns Kalshi and Polymarket titles with minor wording differences", () => {
    const kalshi = buildMatchKey("Fed cuts rates in September 2026 meeting", "Fed rates");
    const poly = buildMatchKey("Will the Fed cut rates in September 2026?", "Fed rates");
    assert.equal(kalshi, poly);
  });

  it("normalizes compact and full currency amounts", () => {
    const a = buildMatchKey("Bitcoin above $100k by end of 2026", "Bitcoin");
    const b = buildMatchKey("Will Bitcoin exceed $100,000 in 2026?", "Bitcoin");
    assert.equal(a, b);
  });

  it("keeps topic prefix and sorts significant tokens", () => {
    const key = buildMatchKey("US recession in 2026", "Macro");
    assert.equal(key, "macro:2026-recession-us");
  });
});

describe("normalizeRawMarket", () => {
  it("builds match_key when not provided", () => {
    const market = normalizeRawMarket(
      {
        venue: "kalshi",
        ticker: "FED-CUT",
        title: "Fed cuts rates in September 2026 meeting",
        topic: "Fed rates",
        yes_price: 0.42,
        volume: 1000,
      },
      "2026-07-09T00:00:00.000Z",
    );
    assert.ok(market);
    assert.equal(market!.match_key, buildMatchKey(market!.title, market!.topic));
  });

  it("honors explicit match_key override", () => {
    const market = normalizeRawMarket(
      {
        venue: "polymarket",
        id: "poly-1",
        question: "Something unrelated",
        match_key: "fed-rates:custom-key",
        yes_price: 0.5,
        volume: 1000,
      },
      "2026-07-09T00:00:00.000Z",
    );
    assert.equal(market?.match_key, "fed-rates:custom-key");
  });
});
