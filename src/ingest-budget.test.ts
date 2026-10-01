import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  capByVolume,
  clampInt,
  ingestBudgetFromEnv,
  KALSHI_MAX_MARKETS,
  KALSHI_MAX_MARKETS_CEILING,
  KALSHI_MAX_PAGES,
  POLYMARKET_MAX_MARKETS,
  slimPolymarketRaw,
} from "./ingest-budget.ts";

describe("ingestBudgetFromEnv", () => {
  it("uses the worker-safe defaults when env is unset", () => {
    const budget = ingestBudgetFromEnv({});
    assert.equal(budget.kalshiMaxPages, KALSHI_MAX_PAGES);
    assert.equal(budget.kalshiMaxMarkets, KALSHI_MAX_MARKETS);
    assert.equal(budget.polymarketMaxMarkets, POLYMARKET_MAX_MARKETS);
    assert.equal(budget.polymarketMaxGammaPages, 2);
  });

  it("clamps overrides so a dashboard var cannot reopen the catalog", () => {
    const budget = ingestBudgetFromEnv({
      KALSHI_MAX_PAGES: "50",
      KALSHI_MAX_MARKETS: "9000",
      POLYMARKET_MAX_MARKETS: "5000",
      POLYMARKET_MAX_GAMMA_PAGES: "20",
    });
    assert.equal(budget.kalshiMaxPages, 3);
    assert.equal(budget.kalshiMaxMarkets, KALSHI_MAX_MARKETS_CEILING);
    assert.equal(budget.polymarketMaxMarkets, POLYMARKET_MAX_MARKETS);
    assert.equal(budget.polymarketMaxGammaPages, 2);
  });

  it("ignores blank and non-numeric overrides", () => {
    assert.equal(clampInt(Number.NaN, 1, 10, 4), 4);
    const budget = ingestBudgetFromEnv({
      KALSHI_MAX_PAGES: "",
      KALSHI_MAX_MARKETS: "nope",
    });
    assert.equal(budget.kalshiMaxPages, KALSHI_MAX_PAGES);
    assert.equal(budget.kalshiMaxMarkets, KALSHI_MAX_MARKETS);
  });
});

describe("capByVolume", () => {
  it("keeps the highest-volume rows and leaves shorter lists alone", () => {
    const rows = [
      { id: "low", volume: 1 },
      { id: "high", volume: 50 },
      { id: "mid", volume: 10 },
    ];
    assert.deepEqual(
      capByVolume(rows, 2, (row) => row.volume).map((row) => row.id),
      ["high", "mid"],
    );
    assert.equal(capByVolume(rows, 10, (row) => row.volume).length, 3);
  });
});

describe("slimPolymarketRaw", () => {
  it("drops description, events, and tags", () => {
    const slim = slimPolymarketRaw({
      id: "1",
      question: "Fed cut?",
      description: "x".repeat(50_000),
      events: [{ id: "e" }],
      tags: ["macro"],
      volumeNum: 10,
    });
    assert.equal(slim.id, "1");
    assert.equal(slim.question, "Fed cut?");
    assert.equal(slim.volumeNum, 10);
    assert.equal("description" in slim, false);
    assert.equal("events" in slim, false);
    assert.equal("tags" in slim, false);
  });
});
