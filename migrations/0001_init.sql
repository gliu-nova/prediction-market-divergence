CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue TEXT NOT NULL,
  market_id TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  title TEXT NOT NULL,
  topic TEXT NOT NULL,
  probability REAL NOT NULL,
  volume REAL,
  liquidity REAL,
  url TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_canonical ON observations(canonical_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_obs_venue ON observations(venue, market_id);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  score INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_score ON signals(score DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_active ON signals(is_active, score DESC);

CREATE TABLE IF NOT EXISTS poll_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO poll_state (key, value) VALUES ('last_poll_at', '');
INSERT OR IGNORE INTO poll_state (key, value) VALUES ('last_markets_ingested', '0');
INSERT OR IGNORE INTO poll_state (key, value) VALUES ('last_opportunities_found', '0');
INSERT OR IGNORE INTO poll_state (key, value) VALUES ('last_error', '');
INSERT OR IGNORE INTO poll_state (key, value) VALUES ('last_poll_source', 'cloudflare');