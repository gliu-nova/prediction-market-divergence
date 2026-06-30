import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractOutcomeTokens,
  normalizeGammaMarket,
  primaryYesToken,
  toLegacyRawMarket,
} from "./normalize.ts";

describe("normalizeGammaMarket", () => {
  it("parses outcomes, token ids, and pricing fields", () => {
    const market = normalizeGammaMarket({
      id: "99",
      question: "Will the Fed cut rates in September 2026?",
      slug: "fed-cut-sep-2026",
      conditionId: "0xfed",
      active: true,
      closed: false,
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.55","0.45"]',
      clobTokenIds: '["yes-token","no-token"]',
      bestBid: 0.54,
      bestAsk: 0.56,
      lastTradePrice: 0.55,
      volumeNum: 100000,
      liquidityNum: 25000,
    });

    assert.ok(market);
    assert.equal(market!.outcomes[0], "Yes");
    assert.equal(market!.bestBid, 0.54);
    const tokens = extractOutcomeTokens(market!, {
      clobTokenIds: '["yes-token","no-token"]',
    });
    assert.equal(tokens.length, 2);
    assert.equal(primaryYesToken(tokens)?.tokenId, "yes-token");
  });
});

describe("toLegacyRawMarket", () => {
  it("preserves poll pipeline fields", () => {
    const market = normalizeGammaMarket({
      id: "1",
      question: "Test market",
      slug: "test-market",
      active: true,
      closed: false,
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.6","0.4"]',
      clobTokenIds: '["yes-token","no-token"]',
      bestBid: 0.59,
      bestAsk: 0.61,
      lastTradePrice: 0.6,
    })!;
    const token = primaryYesToken(extractOutcomeTokens(market, { clobTokenIds: '["yes-token","no-token"]' }))!;
    const legacy = toLegacyRawMarket(
      market,
      token,
      {
        marketId: market.id,
        tokenId: token.tokenId,
        bestBid: 0.59,
        bestAsk: 0.61,
        mid: 0.6,
        spread: 0.02,
        lastTradePrice: 0.6,
        source: "clob",
        sourceTimestamp: "2026-06-26T00:00:00.000Z",
        ingestedAt: "2026-06-26T00:00:01.000Z",
        staleAgeMs: 1000,
      },
      "2026-06-26T00:00:01.000Z",
    );

    assert.equal(legacy.venue, "polymarket");
    assert.equal(legacy.bestBid, 0.59);
    assert.equal(legacy.yes_price, 0.6);
    assert.equal(legacy.stale_age_ms, 1000);
  });
});