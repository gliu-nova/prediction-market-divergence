import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildKalshiMarketsUrl,
  fetchKalshiMarkets,
  fetchKalshiMarketsBounded,
  fetchKalshiMarketsPage,
  fetchKalshiMarketsPages,
  filterMveParlayMarkets,
  isMveParlayMarket,
  projectKalshiMarket,
  KALSHI_MARKETS_PAGE_LIMIT,
  KALSHI_MAX_PAGES,
  type FetchLike,
} from "./kalshi.ts";

function market(ticker: string): Record<string, unknown> {
  return {
    ticker,
    title: `Market ${ticker}`,
    yes_bid_dollars: "0.40",
    yes_ask_dollars: "0.42",
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function createPaginatedFetch(pages: Array<{ markets: Record<string, unknown>[]; cursor?: string | null }>): {
  fetchFn: FetchLike;
  urls: string[];
} {
  const urls: string[] = [];
  let call = 0;

  const fetchFn: FetchLike = async (input) => {
    urls.push(String(input));
    const page = pages[call];
    if (!page) throw new Error(`Unexpected fetch call #${call + 1}`);
    call += 1;
    return jsonResponse({ markets: page.markets, cursor: page.cursor ?? null });
  };

  return { fetchFn, urls };
}

describe("isMveParlayMarket", () => {
  it("detects multivariate parlay tickers and metadata", () => {
    assert.equal(isMveParlayMarket({ ticker: "KXMVESPORTSMULTIGAMEEXTENDED-S2026-ABC" }), true);
    assert.equal(isMveParlayMarket({ ticker: "KXFED-27APR-T3.75" }), false);
    assert.equal(isMveParlayMarket({ event_ticker: "KXMVECROSSCATEGORY-S2026" }), true);
    assert.equal(isMveParlayMarket({ ticker: "FOO", mve_collection_ticker: "KXMV-R" }), true);
    assert.equal(
      isMveParlayMarket({ ticker: "FOO", mve_selected_legs: [{ market_ticker: "LEG-1" }] }),
      true,
    );
  });
});

describe("filterMveParlayMarkets", () => {
  it("removes MVE markets from a page payload", () => {
    const filtered = filterMveParlayMarkets([
      market("KXFED-27APR-T3.75"),
      market("KXMVESPORTSMULTIGAMEEXTENDED-S2026-ABC"),
      market("KXBTC-26DEC-T100K"),
    ]);
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0]?.ticker, "KXFED-27APR-T3.75");
    assert.equal(filtered[1]?.ticker, "KXBTC-26DEC-T100K");
  });
});

describe("buildKalshiMarketsUrl", () => {
  it("requests one page of 400 open markets and excludes MVE markets", () => {
    assert.equal(KALSHI_MARKETS_PAGE_LIMIT, 400);
    const url = buildKalshiMarketsUrl(null);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("limit"), "400");
    assert.equal(parsed.searchParams.get("status"), "open");
    assert.equal(parsed.searchParams.get("mve_filter"), "exclude");
    assert.equal(parsed.searchParams.has("cursor"), false);
  });

  it("includes cursor on subsequent pages", () => {
    const url = buildKalshiMarketsUrl("cursor-abc");
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("cursor"), "cursor-abc");
    assert.equal(parsed.searchParams.get("mve_filter"), "exclude");
    assert.equal(parsed.searchParams.get("limit"), String(KALSHI_MARKETS_PAGE_LIMIT));
  });
});

describe("fetchKalshiMarketsPages", () => {
  it("continues across multiple pages until cursor is empty", async () => {
    const { fetchFn, urls } = createPaginatedFetch([
      { markets: [market("A1"), market("A2")], cursor: "page-2" },
      { markets: [market("B1")], cursor: "page-3" },
      { markets: [market("C1"), market("C2"), market("C3")], cursor: "" },
    ]);

    const { pages, truncated } = await fetchKalshiMarketsPages({ fetchFn, pageThrottleMs: 0, maxPages: 5 });

    assert.equal(pages.length, 3);
    assert.equal(truncated, false);
    assert.equal(pages[0]?.pageIndex, 0);
    assert.equal(pages[0]?.requestCursor, null);
    assert.equal(pages[0]?.responseCursor, "page-2");
    assert.equal(pages[0]?.marketCount, 2);

    assert.equal(pages[1]?.pageIndex, 1);
    assert.equal(pages[1]?.requestCursor, "page-2");
    assert.equal(pages[1]?.responseCursor, "page-3");
    assert.equal(pages[1]?.marketCount, 1);

    assert.equal(pages[2]?.pageIndex, 2);
    assert.equal(pages[2]?.requestCursor, "page-3");
    assert.equal(pages[2]?.responseCursor, null);
    assert.equal(pages[2]?.marketCount, 3);

    assert.equal(urls.length, 3);
    assert.match(urls[0] ?? "", /limit=400/);
    assert.match(urls[0] ?? "", /mve_filter=exclude/);
    assert.match(urls[1] ?? "", /cursor=page-2/);
    assert.match(urls[2] ?? "", /cursor=page-3/);
  });

  it("stops after a single page when cursor is missing", async () => {
    const { fetchFn, urls } = createPaginatedFetch([
      { markets: [market("ONLY")], cursor: null },
    ]);

    const { pages, truncated } = await fetchKalshiMarketsPages({ fetchFn, pageThrottleMs: 0 });
    assert.equal(pages.length, 1);
    assert.equal(truncated, false);
    assert.equal(urls.length, 1);
  });

  it("stops at maxPages even when more pages are available", async () => {
    const { fetchFn, urls } = createPaginatedFetch([
      { markets: [market("P1")], cursor: "page-2" },
      { markets: [market("P2")], cursor: "page-3" },
      { markets: [market("P3")], cursor: "page-4" },
    ]);

    const { pages, truncated } = await fetchKalshiMarketsPages({
      fetchFn,
      pageThrottleMs: 0,
      maxPages: 2,
    });
    assert.equal(pages.length, 2);
    assert.equal(truncated, true);
    assert.equal(urls.length, 2);
    assert.equal(pages[1]?.responseCursor, "page-3");
  });

  it("defaults maxPages to KALSHI_MAX_PAGES", () => {
    assert.equal(KALSHI_MAX_PAGES, 1);
  });

  it("waits between pages when pageThrottleMs is set", async () => {
    const { fetchFn } = createPaginatedFetch([
      { markets: [market("A")], cursor: "page-2" },
      { markets: [market("B")], cursor: null },
    ]);

    const startedAt = Date.now();
    await fetchKalshiMarketsPages({ fetchFn, pageThrottleMs: 50, maxPages: 2 });
    assert.ok(Date.now() - startedAt >= 45);
  });
});

describe("fetchKalshiMarkets", () => {
  it("returns all markets across pages with ingest metadata", async () => {
    const { fetchFn } = createPaginatedFetch([
      { markets: [market("ONE")], cursor: "next" },
      { markets: [market("TWO"), market("THREE")], cursor: null },
    ]);

    const result = await fetchKalshiMarkets("2026-06-26T00:00:00.000Z", {
      fetchFn,
      pageThrottleMs: 0,
      maxPages: 2,
    });

    assert.equal(result.pages.length, 2);
    assert.equal(result.truncated, false);
    assert.equal(result.markets.length, 3);
    assert.equal(result.markets[0]?.ticker, "ONE");
    assert.equal(result.markets[0]?.venue, "kalshi");
    assert.equal(result.markets[0]?.fetched_at, "2026-06-26T00:00:00.000Z");
    assert.equal(result.markets[0]?.url, "https://kalshi.com/markets/ONE");
    assert.equal(result.markets[2]?.ticker, "THREE");
  });

  it("drops MVE markets that slip through the API response", async () => {
    const { fetchFn } = createPaginatedFetch([
      {
        markets: [market("KXFED-27APR-T3.75"), market("KXMVESPORTSMULTIGAMEEXTENDED-S2026-ABC")],
        cursor: null,
      },
    ]);

    const result = await fetchKalshiMarkets("2026-06-26T00:00:00.000Z", { fetchFn, pageThrottleMs: 0 });
    assert.equal(result.markets.length, 1);
    assert.equal(result.markets[0]?.ticker, "KXFED-27APR-T3.75");
  });

  it("drops fat fields the worker does not read", () => {
    const slim = projectKalshiMarket(
      {
        ticker: "KXFED-27APR-T3.75",
        title: "Fed",
        rules_primary: "x".repeat(8000),
        rules_secondary: "y".repeat(8000),
        volume_fp: "1200",
      },
      "2026-10-01T00:00:00.000Z",
    );
    assert.equal(slim.ticker, "KXFED-27APR-T3.75");
    assert.equal(slim.volume_fp, "1200");
    assert.equal("rules_primary" in slim, false);
    assert.equal("rules_secondary" in slim, false);
  });
});

describe("fetchKalshiMarketsBounded", () => {
  it("keeps the highest-volume markets and does not retain rules text", async () => {
    const { fetchFn, urls } = createPaginatedFetch([
      {
        markets: [
          { ...market("LOW"), volume_fp: "1", rules_primary: "fat" },
          { ...market("HIGH"), volume_fp: "900", rules_primary: "fat" },
        ],
        cursor: "page-2",
      },
      {
        markets: [{ ...market("MID"), volume_fp: "50", rules_secondary: "fat" }],
        cursor: "page-3",
      },
      {
        markets: [{ ...market("UNSEEN"), volume_fp: "9999" }],
        cursor: null,
      },
    ]);

    const result = await fetchKalshiMarketsBounded("2026-10-01T00:00:00.000Z", {
      fetchFn,
      pageThrottleMs: 0,
      maxPages: 2,
      maxMarkets: 2,
    });

    assert.deepEqual(
      result.markets.map((row) => row.ticker),
      ["HIGH", "MID"],
    );
    assert.equal(result.pages_fetched, 2);
    assert.equal(result.truncated, true);
    assert.equal(urls.length, 2);
    assert.equal("rules_primary" in (result.markets[0] ?? {}), false);
    assert.equal("rules_secondary" in (result.markets[1] ?? {}), false);
  });

  it("stops after the default single page when another page exists", async () => {
    const { fetchFn, urls } = createPaginatedFetch([
      { markets: [market("KEEP")], cursor: "page-2" },
      { markets: [market("SKIP")], cursor: null },
    ]);

    const result = await fetchKalshiMarketsBounded("2026-10-08T00:00:00.000Z", {
      fetchFn,
      pageThrottleMs: 0,
    });

    assert.equal(result.pages_fetched, 1);
    assert.equal(result.truncated, true);
    assert.equal(urls.length, 1);
    assert.match(urls[0] ?? "", /limit=400/);
    assert.deepEqual(
      result.markets.map((row) => row.ticker),
      ["KEEP"],
    );
  });
});

describe("fetchKalshiMarketsPage", () => {
  it("retries after 429 and succeeds on a later attempt", async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls += 1;
      if (calls < 3) return jsonResponse({ error: "rate limited" }, 429, { "Retry-After": "0" });
      return jsonResponse({ markets: [market("RETRY-OK")], cursor: null });
    };

    const page = await fetchKalshiMarketsPage(null, { fetchFn, maxRetries: 5 });
    assert.equal(calls, 3);
    assert.equal(page.markets.length, 1);
    assert.equal(page.markets[0]?.ticker, "RETRY-OK");
  });

  it("throws when Kalshi keeps returning 429", async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ error: "rate limited" }, 429);
    await assert.rejects(
      () => fetchKalshiMarketsPage(null, { fetchFn, maxRetries: 2 }),
      /Kalshi fetch failed: 429/,
    );
  });

  it("retries 5xx and succeeds on a later attempt", async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls += 1;
      if (calls < 3) return jsonResponse({ error: "server error" }, 500, { "Retry-After": "0" });
      return jsonResponse({ markets: [market("RETRY-5XX")], cursor: null });
    };

    const page = await fetchKalshiMarketsPage(null, { fetchFn, maxRetries: 5 });
    assert.equal(calls, 3);
    assert.equal(page.markets[0]?.ticker, "RETRY-5XX");
  });

  it("throws immediately for non-retryable client errors", async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ error: "bad request" }, 400);
    await assert.rejects(() => fetchKalshiMarketsPage(null, { fetchFn }), /Kalshi fetch failed: 400/);
  });
});