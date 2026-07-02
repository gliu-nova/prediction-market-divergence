-- Tiered pipeline: compact live state in D1 (raw history in R2, analytics via DuckDB).

CREATE TABLE IF NOT EXISTS markets (
  venue TEXT NOT NULL,
  market_id TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  title TEXT NOT NULL,
  topic TEXT NOT NULL,
  url TEXT NOT NULL,
  match_key TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  category TEXT,
  metadata_json TEXT,
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (venue, market_id)
);
CREATE INDEX IF NOT EXISTS idx_markets_match_key ON markets(match_key);
CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(active, venue);

CREATE TABLE IF NOT EXISTS latest_prices (
  venue TEXT NOT NULL,
  market_id TEXT NOT NULL,
  probability REAL NOT NULL,
  volume REAL,
  liquidity REAL,
  best_bid REAL,
  best_ask REAL,
  spread REAL,
  observed_at TEXT NOT NULL,
  ingest_ts TEXT NOT NULL,
  PRIMARY KEY (venue, market_id)
);
CREATE INDEX IF NOT EXISTS idx_latest_prices_observed ON latest_prices(observed_at DESC);

CREATE TABLE IF NOT EXISTS opportunity_events (
  id TEXT PRIMARY KEY,
  match_key TEXT NOT NULL,
  topic TEXT NOT NULL,
  title TEXT NOT NULL,
  difference_pct_points REAL NOT NULL,
  score INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_opportunity_events_detected ON opportunity_events(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_opportunity_events_match_key ON opportunity_events(match_key, detected_at DESC);

CREATE TABLE IF NOT EXISTS bot_posts (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT,
  tweet_text TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'posted'
);
CREATE INDEX IF NOT EXISTS idx_bot_posts_posted_at ON bot_posts(posted_at DESC);

CREATE TABLE IF NOT EXISTS indicator_summaries (
  match_key TEXT NOT NULL,
  venue TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  prob_change_1h REAL,
  prob_change_24h REAL,
  max_gap_30d REAL,
  spread_p50 REAL,
  volume_p50 REAL,
  similar_events_count INTEGER,
  reversion_rate REAL,
  payload_json TEXT,
  PRIMARY KEY (match_key, venue, computed_at)
);
CREATE INDEX IF NOT EXISTS idx_indicator_summaries_match ON indicator_summaries(match_key, computed_at DESC);

CREATE TABLE IF NOT EXISTS cooldowns (
  key TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cooldowns_expires ON cooldowns(expires_at);

INSERT OR IGNORE INTO poll_state (key, value) VALUES ('last_discover_at', '');
INSERT OR IGNORE INTO poll_state (key, value) VALUES ('last_ingest_at', '');
INSERT OR IGNORE INTO poll_state (key, value) VALUES ('last_detect_at', '');
INSERT OR IGNORE INTO poll_state (key, value) VALUES ('last_summarize_at', '');