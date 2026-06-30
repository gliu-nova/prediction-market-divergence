export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ENVIRONMENT?: string;
  APP_NAME?: string;
  USE_MOCK?: string;
  MIN_DIVERGENCE_PCT_POINTS?: string;
  MIN_VOLUME?: string;
  LOOKBACK_DAYS?: string;
  OPPORTUNITY_MAX_AGE_HOURS?: string;
  OBSERVATION_RETENTION_DAYS?: string;
  POLL_SECRET?: string;
  KALSHI_ACCESS_KEY?: string;
  KALSHI_PRIVATE_KEY?: string;
  POLYMARKET_GAMMA_URL?: string;
  POLYMARKET_CLOB_URL?: string;
  POLYMARKET_CLOB_WS_URL?: string;
  POLYMARKET_DATA_API_URL?: string;
  POLYMARKET_PAGE_SIZE?: string;
  POLYMARKET_MAX_MARKETS?: string;
  POLYMARKET_MAX_GAMMA_PAGES?: string;
  POLYMARKET_CLOB_ENRICH_MAX?: string;
  POLYMARKET_ORDER_BOOK_DEPTH?: string;
  POLYMARKET_MAX_RETRIES?: string;
  POLYMARKET_RETRY_BASE_MS?: string;
  POLYMARKET_RATE_LIMIT_MS?: string;
  POLYMARKET_STALE_MS?: string;
  POLYMARKET_TRADE_LIMIT?: string;
  POLYGON_RPC_URL?: string;
}

export interface MarketSide {
  venue: string;
  probability: number;
  url: string;
  market_id: string;
  volume?: number | null;
  liquidity?: number | null;
}

export interface Signal {
  id: string;
  type: "prediction_market_divergence";
  title: string;
  asset_or_topic: string;
  market_a: MarketSide;
  market_b: MarketSide;
  difference_pct_points: number;
  implied_arb_profit_pct: number;
  lookback_context: string;
  score: number;
  created_at: string;
  tweet_hint: string;
  is_active: boolean;
}

export interface Opportunity extends Signal {
  detected_at: string;
  min_volume: number;
}

export interface CanonicalMarket {
  canonical_id: string;
  title: string;
  topic: string;
  venue: "kalshi" | "polymarket";
  market_id: string;
  probability: number;
  volume?: number | null;
  liquidity?: number | null;
  url: string;
  observed_at: string;
  match_key: string;
}

export interface MarketObservation {
  venue: string;
  market_id: string;
  canonical_id: string;
  title: string;
  topic: string;
  probability: number;
  volume?: number | null;
  liquidity?: number | null;
  url: string;
  observed_at: string;
}

export interface MatchedPair {
  match_key: string;
  topic: string;
  title: string;
  market_a: CanonicalMarket;
  market_b: CanonicalMarket;
}

export interface IngestedMarketRow {
  venue: string;
  market_id: string;
  title: string;
  topic: string;
  probability: number;
  volume: number | null;
  liquidity: number | null;
  url: string;
  match_key: string;
  observed_at: string;
}

export interface MatchedPairRow {
  match_key: string;
  topic: string;
  title: string;
  market_a: {
    venue: string;
    market_id: string;
    title: string;
    probability: number;
    url: string;
  };
  market_b: {
    venue: string;
    market_id: string;
    title: string;
    probability: number;
    url: string;
  };
}

export interface IngestedMarketsPage {
  poll_ts: string | null;
  total: number;
  offset: number;
  limit: number;
  venue_counts: { kalshi: number; polymarket: number };
  markets: IngestedMarketRow[];
}

export interface MatchedPairsPage {
  poll_ts: string | null;
  total: number;
  offset: number;
  limit: number;
  pairs: MatchedPairRow[];
}

export interface IngestionSummary {
  total_markets: number;
  kalshi_markets: number;
  polymarket_markets: number;
  matched_pairs: number;
}

export interface OutputSummary {
  active_opportunities: number;
  signals_total: number;
  last_opportunities_found: number;
}

export interface VenueBreakdown {
  markets_ingested: number;
  markets_in_pairs: number;
  markets_enriched: number | null;
  snapshots_stored: number | null;
  active_signals: number;
  signals_total: number;
}

export interface HealthStatus {
  status: string;
  last_poll_at: string | null;
  last_error: string | null;
  markets_tracked: number;
  active_opportunities: number;
  signals_total: number;
  sources: Record<string, string>;
  ingestion: IngestionSummary;
  output: OutputSummary;
  venues: {
    kalshi: VenueBreakdown;
    polymarket: VenueBreakdown;
  };
}

export interface AppConfig {
  useMock: boolean;
  minDivergencePctPoints: number;
  minVolume: number;
  lookbackDays: number;
  opportunityMaxAgeHours: number;
  observationRetentionDays: number;
  scoring: {
    weightDifference: number;
    weightLiquidity: number;
    weightRecency: number;
    weightRarity: number;
  };
}