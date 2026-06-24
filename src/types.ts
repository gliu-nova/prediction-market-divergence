export interface Env {
  DB: D1Database;
  ENVIRONMENT?: string;
  APP_NAME?: string;
  USE_MOCK?: string;
  MIN_DIVERGENCE_PCT_POINTS?: string;
  MIN_VOLUME?: string;
  LOOKBACK_DAYS?: string;
  OPPORTUNITY_MAX_AGE_HOURS?: string;
  OBSERVATION_RETENTION_DAYS?: string;
  POLL_SECRET?: string;
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

export interface HealthStatus {
  status: string;
  last_poll_at: string | null;
  markets_tracked: number;
  active_opportunities: number;
  signals_total: number;
  sources: Record<string, string>;
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