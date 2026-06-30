import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultPolymarketConfig } from "./config.ts";
import { runPolymarketSnapshot } from "./snapshot.ts";
import type { FetchLike } from "./http.ts";

const SAMPLE_MARKET = {
  id: "123",
  question: "Will BTC exceed $100k in 2026?",
  slug: "btc-100k-2026",
  conditionId: "0xabc",
  active: true,
  closed: false,
  volumeNum: 50000,
  liquidityNum: 12000,
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.41","0.59"]',
  clobTokenIds: '["token-yes-1","token-no-1"]',
  bestBid: 0.4,
  bestAsk: 0.42,
  lastTradePrice: 0.41,
  enableOrderBook: true,
  updatedAt: "2026-06-26T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("runPolymarketSnapshot", () => {
  it("discovers gamma markets and enriches with batch CLOB prices", async () => {
    let call = 0;
    const fetchFn: FetchLike = async (input, init) => {
      const url = String(input);
      call += 1;
      if (url.includes("gamma-api.polymarket.com/markets")) {
        return jsonResponse([SAMPLE_MARKET]);
      }
      if (url.includes("/prices") && init?.method === "POST") {
        return jsonResponse({ "token-yes-1": { BUY: "0.40", SELL: "0.42" } });
      }

      return jsonResponse({});
    };

    const config = {
      ...defaultPolymarketConfig,
      minRequestIntervalMs: 0,
      retryBaseMs: 1,
      clobEnrichMaxMarkets: 10,
      maxGammaPages: 1,
      discoveryMaxMarkets: 10,
    };

    const result = await runPolymarketSnapshot(config, {
      fetchFn,
      includeOrderBooks: false,
      limit: 5,
      mode: "snapshot",
    });

    assert.equal(result.markets.length, 1);
    assert.equal(result.run.status, "ok");
    assert.ok(result.priceSnapshots.some((s) => s.source === "gamma"));
    assert.ok(result.priceSnapshots.some((s) => s.source === "clob"));
    assert.equal(result.legacyRawMarkets.length, 1);
    assert.equal(result.legacyRawMarkets[0]?.venue, "polymarket");
    assert.equal(result.legacyRawMarkets[0]?.bestBid, 0.4);
    assert.ok(call >= 2);
  });

  it("retries gamma requests on 429", async () => {
    let gammaCalls = 0;
    const fetchFn: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.includes("gamma-api.polymarket.com/markets")) {
        gammaCalls += 1;
        if (gammaCalls < 2) return jsonResponse({ error: "rate limited" }, 429, { "Retry-After": "0" });
        return jsonResponse([SAMPLE_MARKET]);
      }
      if (url.includes("/prices") && init?.method === "POST") {
        return jsonResponse({ "token-yes-1": { BUY: "0.40", SELL: "0.42" } });
      }
      return jsonResponse({});
    };

    const config = {
      ...defaultPolymarketConfig,
      minRequestIntervalMs: 0,
      retryBaseMs: 1,
      maxRetries: 3,
      maxGammaPages: 1,
      discoveryMaxMarkets: 5,
    };

    const result = await runPolymarketSnapshot(config, { fetchFn, includeOrderBooks: false, mode: "snapshot" });
    assert.equal(result.markets.length, 1);
    assert.equal(gammaCalls, 2);
  });
});