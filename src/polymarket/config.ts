import {
  clampInt,
  POLYMARKET_MAX_GAMMA_PAGES,
  POLYMARKET_MAX_GAMMA_PAGES_CEILING,
  POLYMARKET_MAX_MARKETS,
  POLYMARKET_MAX_MARKETS_CEILING,
} from "../ingest-budget.ts";

export interface PolymarketEndpoints {
  gammaBaseUrl: string;
  clobBaseUrl: string;
  clobWsUrl: string;
  dataApiBaseUrl: string;
  polygonRpcUrl: string | null;
}

export interface PolymarketIngestConfig {
  endpoints: PolymarketEndpoints;
  discoveryPageSize: number;
  discoveryMaxMarkets: number;
  maxGammaPages: number;
  clobEnrichMaxMarkets: number;
  orderBookDepth: number;
  maxRetries: number;
  retryBaseMs: number;
  minRequestIntervalMs: number;
  staleDataThresholdMs: number;
  tradeBackfillLimit: number;
}

const DEFAULT_ENDPOINTS: PolymarketEndpoints = {
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",
  clobWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  dataApiBaseUrl: "https://data-api.polymarket.com",
  polygonRpcUrl: null,
};

export function polymarketConfigFromEnv(env: Record<string, string | undefined> = {}): PolymarketIngestConfig {
  return {
    endpoints: {
      gammaBaseUrl: env.POLYMARKET_GAMMA_URL ?? DEFAULT_ENDPOINTS.gammaBaseUrl,
      clobBaseUrl: env.POLYMARKET_CLOB_URL ?? DEFAULT_ENDPOINTS.clobBaseUrl,
      clobWsUrl: env.POLYMARKET_CLOB_WS_URL ?? DEFAULT_ENDPOINTS.clobWsUrl,
      dataApiBaseUrl: env.POLYMARKET_DATA_API_URL ?? DEFAULT_ENDPOINTS.dataApiBaseUrl,
      polygonRpcUrl: env.POLYGON_RPC_URL ?? null,
    },
    discoveryPageSize: parseInt(env.POLYMARKET_PAGE_SIZE ?? "100", 10),
    discoveryMaxMarkets: clampInt(
      parseInt(env.POLYMARKET_MAX_MARKETS ?? "", 10),
      1,
      POLYMARKET_MAX_MARKETS_CEILING,
      POLYMARKET_MAX_MARKETS,
    ),
    maxGammaPages: clampInt(
      parseInt(env.POLYMARKET_MAX_GAMMA_PAGES ?? "", 10),
      1,
      POLYMARKET_MAX_GAMMA_PAGES_CEILING,
      POLYMARKET_MAX_GAMMA_PAGES,
    ),
    clobEnrichMaxMarkets: clampInt(
      parseInt(env.POLYMARKET_CLOB_ENRICH_MAX ?? "", 10),
      1,
      POLYMARKET_MAX_MARKETS_CEILING,
      POLYMARKET_MAX_MARKETS,
    ),
    orderBookDepth: parseInt(env.POLYMARKET_ORDER_BOOK_DEPTH ?? "10", 10),
    maxRetries: parseInt(env.POLYMARKET_MAX_RETRIES ?? "5", 10),
    retryBaseMs: parseInt(env.POLYMARKET_RETRY_BASE_MS ?? "500", 10),
    minRequestIntervalMs: parseInt(env.POLYMARKET_RATE_LIMIT_MS ?? "100", 10),
    staleDataThresholdMs: parseInt(env.POLYMARKET_STALE_MS ?? String(15 * 60 * 1000), 10),
    tradeBackfillLimit: parseInt(env.POLYMARKET_TRADE_LIMIT ?? "200", 10),
  };
}

export const defaultPolymarketConfig = polymarketConfigFromEnv();