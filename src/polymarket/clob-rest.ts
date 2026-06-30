import type { PolymarketIngestConfig } from "./config.ts";
import { RateLimitedClient } from "./http.ts";
import type { OrderBookLevel, OrderBookSnapshot } from "./types.ts";

export interface ClobPriceQuote {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  lastTradePrice: number | null;
  sourceTimestamp: string | null;
}

interface ClobBookResponse {
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
  last_trade_price?: string;
  timestamp?: string;
}

type BatchPriceResponse = Record<string, { BUY?: string; SELL?: string }>;

function toNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function fetchBatchPrices(
  config: PolymarketIngestConfig,
  client: RateLimitedClient,
  tokenIds: string[],
): Promise<Map<string, { bestBid: number | null; bestAsk: number | null }>> {
  const result = new Map<string, { bestBid: number | null; bestAsk: number | null }>();
  if (!tokenIds.length) return result;

  for (const group of chunk(tokenIds, 50)) {
    const payload = group.flatMap((tokenId) => [
      { token_id: tokenId, side: "BUY" },
      { token_id: tokenId, side: "SELL" },
    ]);
    const url = `${config.endpoints.clobBaseUrl}/prices`;
    const data = await client.fetchJson<BatchPriceResponse>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    for (const tokenId of group) {
      const quote = data[tokenId];
      result.set(tokenId, {
        bestBid: toNumber(quote?.BUY),
        bestAsk: toNumber(quote?.SELL),
      });
    }
  }

  return result;
}

export async function fetchMidpoints(
  config: PolymarketIngestConfig,
  client: RateLimitedClient,
  tokenIds: string[],
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  for (const tokenId of tokenIds) {
    const url = `${config.endpoints.clobBaseUrl}/midpoint?token_id=${encodeURIComponent(tokenId)}`;
    const data = await client.fetchJson<{ mid?: string }>(url);
    result.set(tokenId, toNumber(data.mid));
  }
  return result;
}

export async function fetchLastTradePrices(
  config: PolymarketIngestConfig,
  client: RateLimitedClient,
  tokenIds: string[],
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  for (const tokenId of tokenIds) {
    const url = `${config.endpoints.clobBaseUrl}/last-trade-price?token_id=${encodeURIComponent(tokenId)}`;
    const data = await client.fetchJson<{ price?: string }>(url);
    result.set(tokenId, toNumber(data.price));
  }
  return result;
}

export async function fetchOrderBook(
  config: PolymarketIngestConfig,
  client: RateLimitedClient,
  marketId: string,
  tokenId: string,
  depth = 10,
): Promise<OrderBookSnapshot | null> {
  const url = `${config.endpoints.clobBaseUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
  const data = await client.fetchJson<ClobBookResponse>(url);
  const bids = (data.bids ?? []).slice(0, depth).map((level, index): OrderBookLevel => ({
    side: "bid",
    price: Number(level.price),
    size: Number(level.size),
    level: index,
  }));
  const asks = (data.asks ?? []).slice(0, depth).map((level, index): OrderBookLevel => ({
    side: "ask",
    price: Number(level.price),
    size: Number(level.size),
    level: index,
  }));

  return {
    marketId,
    tokenId,
    bids,
    asks,
    lastTradePrice: toNumber(data.last_trade_price),
    sourceTimestamp: data.timestamp ? new Date(Number(data.timestamp) * 1000).toISOString() : null,
    ingestedAt: new Date().toISOString(),
  };
}

export async function enrichTokenPrices(
  config: PolymarketIngestConfig,
  client: RateLimitedClient,
  tokenIds: string[],
  opts: { includeMidpoint?: boolean; includeLastTrade?: boolean } = {},
): Promise<ClobPriceQuote[]> {
  const unique = [...new Set(tokenIds)];
  const batch = await fetchBatchPrices(config, client, unique);
  const mids = opts.includeMidpoint ? await fetchMidpoints(config, client, unique) : new Map<string, number | null>();
  const lastTrades = opts.includeLastTrade
    ? await fetchLastTradePrices(config, client, unique)
    : new Map<string, number | null>();

  return unique.map((tokenId) => {
    const prices = batch.get(tokenId) ?? { bestBid: null, bestAsk: null };
    const mid =
      mids.get(tokenId) ??
      (prices.bestBid != null && prices.bestAsk != null ? (prices.bestBid + prices.bestAsk) / 2 : null);
    const lastTradePrice = lastTrades.get(tokenId) ?? null;
    return {
      tokenId,
      bestBid: prices.bestBid,
      bestAsk: prices.bestAsk,
      mid,
      lastTradePrice,
      sourceTimestamp: new Date().toISOString(),
    };
  });
}