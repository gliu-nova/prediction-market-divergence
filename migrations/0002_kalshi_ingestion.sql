CREATE TABLE IF NOT EXISTS kalshi_ingest_batches (
  poll_ts TEXT PRIMARY KEY,
  page_count INTEGER NOT NULL,
  raw_market_count INTEGER NOT NULL,
  normalized_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kalshi_raw_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_ts TEXT NOT NULL,
  page_index INTEGER NOT NULL,
  request_cursor TEXT,
  response_cursor TEXT,
  market_count INTEGER NOT NULL,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE(poll_ts, page_index)
);
CREATE INDEX IF NOT EXISTS idx_kalshi_raw_pages_poll_ts ON kalshi_raw_pages(poll_ts);

CREATE TABLE IF NOT EXISTS kalshi_normalized_markets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_ts TEXT NOT NULL,
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
  UNIQUE(poll_ts, market_id)
);
CREATE INDEX IF NOT EXISTS idx_kalshi_normalized_poll_ts ON kalshi_normalized_markets(poll_ts);