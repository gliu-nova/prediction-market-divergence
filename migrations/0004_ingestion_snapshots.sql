CREATE TABLE IF NOT EXISTS ingested_markets (
  poll_ts TEXT NOT NULL,
  venue TEXT NOT NULL,
  market_id TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  title TEXT NOT NULL,
  topic TEXT NOT NULL,
  probability REAL NOT NULL,
  volume REAL,
  liquidity REAL,
  url TEXT NOT NULL,
  match_key TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (poll_ts, venue, market_id)
);
CREATE INDEX IF NOT EXISTS idx_ingested_markets_venue ON ingested_markets(venue);
CREATE INDEX IF NOT EXISTS idx_ingested_markets_title ON ingested_markets(title);

CREATE TABLE IF NOT EXISTS matched_pair_snapshots (
  poll_ts TEXT NOT NULL,
  match_key TEXT NOT NULL,
  topic TEXT NOT NULL,
  title TEXT NOT NULL,
  market_a_venue TEXT NOT NULL,
  market_a_id TEXT NOT NULL,
  market_a_title TEXT NOT NULL,
  market_a_probability REAL NOT NULL,
  market_a_url TEXT NOT NULL,
  market_b_venue TEXT NOT NULL,
  market_b_id TEXT NOT NULL,
  market_b_title TEXT NOT NULL,
  market_b_probability REAL NOT NULL,
  market_b_url TEXT NOT NULL,
  PRIMARY KEY (poll_ts, match_key)
);