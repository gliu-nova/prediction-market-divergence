import type { PolymarketIngestConfig } from "./config.ts";
import { RateLimitedClient } from "./http.ts";
import type { Trade } from "./types.ts";

interface DataApiTradeRow {
  proxyWallet?: string;
  side?: string;
  asset?: string;
  conditionId?: string;
  size?: number;
  price?: number;
  timestamp?: number;
  title?: string;
  slug?: string;
  outcome?: string;
  name?: string;
  transactionHash?: string;
}

export interface FetchTradesOptions {
  marketId?: string;
  conditionId?: string;
  tokenId?: string;
  since?: string;
  limit?: number;
}

export async function fetchRecentTrades(
  config: PolymarketIngestConfig,
  client: RateLimitedClient,
  opts: FetchTradesOptions = {},
): Promise<Trade[]> {
  const params = new URLSearchParams({
    limit: String(opts.limit ?? config.tradeBackfillLimit),
  });
  if (opts.conditionId) params.set("conditionId", opts.conditionId);
  if (opts.tokenId) params.set("asset", opts.tokenId);
  if (opts.since) {
    const sinceTs = Math.floor(new Date(opts.since).getTime() / 1000);
    if (!Number.isNaN(sinceTs)) params.set("startTs", String(sinceTs));
  }

  const url = `${config.endpoints.dataApiBaseUrl}/trades?${params}`;
  const rows = await client.fetchJson<DataApiTradeRow[]>(url);
  const ingestedAt = new Date().toISOString();

  return (Array.isArray(rows) ? rows : []).map((row, index) => ({
    id: `${row.transactionHash ?? row.asset ?? "trade"}-${row.timestamp ?? index}`,
    marketId: opts.marketId ?? null,
    conditionId: row.conditionId ?? opts.conditionId ?? null,
    tokenId: row.asset ?? opts.tokenId ?? null,
    side: row.side ?? null,
    price: Number(row.price ?? 0),
    size: Number(row.size ?? 0),
    outcome: row.outcome ?? null,
    traderName: row.name ?? null,
    transactionHash: row.transactionHash ?? null,
    tradedAt: row.timestamp ? new Date(row.timestamp * 1000).toISOString() : ingestedAt,
    ingestedAt,
    source: "data-api" as const,
  }));
}