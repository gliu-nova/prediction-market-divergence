import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildKalshiMarketUrl, buildPolymarketMarketUrl } from "./market-urls.ts";

describe("buildKalshiMarketUrl", () => {
  it("builds full path with uppercase tickers from API fields", () => {
    const url = buildKalshiMarketUrl({
      ticker: "KXFED-27APR-T4.25",
      event_ticker: "KXFED-27APR",
    });
    assert.equal(url, "https://kalshi.com/markets/KXFED/KXFED-27APR/KXFED-27APR-T4.25");
  });

  it("uses series_ticker when provided", () => {
    const url = buildKalshiMarketUrl({
      ticker: "KXBTC-26DEC-T100K",
      event_ticker: "KXBTC-26DEC",
      series_ticker: "KXBTC",
    });
    assert.equal(url, "https://kalshi.com/markets/KXBTC/KXBTC-26DEC/KXBTC-26DEC-T100K");
  });

  it("falls back to market ticker only when event_ticker is missing", () => {
    const url = buildKalshiMarketUrl({ ticker: "recession-2026" });
    assert.equal(url, "https://kalshi.com/markets/RECESSION-2026");
  });
});

describe("buildPolymarketMarketUrl", () => {
  it("uses /market/ path with market slug", () => {
    const url = buildPolymarketMarketUrl({ slug: "fed-cut-sep-2026" }, "99");
    assert.equal(url, "https://polymarket.com/market/fed-cut-sep-2026");
  });

  it("uses market slug even when events[] is populated", () => {
    const url = buildPolymarketMarketUrl(
      {
        slug: "new-rhianna-album-before-gta-vi-926",
        events: [{ slug: "what-will-happen-before-gta-vi" }],
      },
      "23784",
    );
    assert.equal(url, "https://polymarket.com/market/new-rhianna-album-before-gta-vi-926");
  });
});
