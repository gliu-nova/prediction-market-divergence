CREATE TABLE IF NOT EXISTS poly_ingestion_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  markets_discovered INTEGER NOT NULL DEFAULT 0,
  markets_enriched INTEGER NOT NULL DEFAULT 0,
  snapshots_stored INTEGER NOT NULL DEFAULT 0,
  order_books_stored INTEGER NOT NULL DEFAULT 0,
  trades_stored INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS poly_markets (
  id TEXT PRIMARY KEY,
  event_id TEXT,
  slug TEXT,
  condition_id TEXT,
  question TEXT NOT NULL,
  description TEXT,
  category TEXT,
  tags_json TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0,
  start_date TEXT,
  end_date TEXT,
  volume REAL,
  liquidity REAL,
  outcomes_json TEXT,
  outcome_prices_json TEXT,
  enable_order_book INTEGER NOT NULL DEFAULT 0,
  best_bid REAL,
  best_ask REAL,
  last_trade_price REAL,
  source_updated_at TEXT,
  url TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS poly_price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  best_bid REAL,
  best_ask REAL,
  mid REAL,
  spread REAL,
  last_trade_price REAL,
  source TEXT NOT NULL,
  source_timestamp TEXT,
  ingested_at TEXT NOT NULL,
  stale_age_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_poly_price_snapshots_market ON poly_price_snapshots(market_id, ingested_at);

CREATE TABLE IF NOT EXISTS poly_order_book_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  last_trade_price REAL,
  source_timestamp TEXT,
  ingested_at TEXT NOT NULL,
  bids_json TEXT NOT NULL,
  asks_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS poly_trades (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  market_id TEXT,
  condition_id TEXT,
  token_id TEXT,
  side TEXT,
  price REAL NOT NULL,
  size REAL NOT NULL,
  outcome TEXT,
  trader_name TEXT,
  transaction_hash TEXT,
  traded_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_poly_trades_market ON poly_trades(market_id, traded_at);