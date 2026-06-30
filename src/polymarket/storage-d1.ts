import type { PolymarketSnapshotResult } from "./types.ts";

export async function savePolymarketSnapshotD1(db: D1Database, result: PolymarketSnapshotResult): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO poly_ingestion_runs
         (id, mode, started_at, finished_at, status, markets_discovered, markets_enriched, snapshots_stored, order_books_stored, trades_stored, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           finished_at = excluded.finished_at,
           status = excluded.status,
           markets_discovered = excluded.markets_discovered,
           markets_enriched = excluded.markets_enriched,
           snapshots_stored = excluded.snapshots_stored,
           order_books_stored = excluded.order_books_stored,
           trades_stored = excluded.trades_stored,
           error = excluded.error`,
      )
      .bind(
        result.run.id,
        result.run.mode,
        result.run.startedAt,
        result.run.finishedAt,
        result.run.status,
        result.run.marketsDiscovered,
        result.run.marketsEnriched,
        result.run.snapshotsStored,
        result.run.orderBooksStored,
        result.run.tradesStored,
        result.run.error,
      ),
  ];

  for (const market of result.markets) {
    statements.push(
      db
        .prepare(
          `INSERT INTO poly_markets
           (id, event_id, slug, condition_id, question, description, category, tags_json, active, closed, resolved,
            start_date, end_date, volume, liquidity, outcomes_json, outcome_prices_json, enable_order_book,
            best_bid, best_ask, last_trade_price, source_updated_at, url, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             question = excluded.question,
             volume = excluded.volume,
             liquidity = excluded.liquidity,
             best_bid = excluded.best_bid,
             best_ask = excluded.best_ask,
             last_trade_price = excluded.last_trade_price,
             source_updated_at = excluded.source_updated_at,
             updated_at = excluded.updated_at`,
        )
        .bind(
          market.id,
          market.eventId,
          market.slug,
          market.conditionId,
          market.question,
          market.description,
          market.category,
          JSON.stringify(market.tags),
          market.active ? 1 : 0,
          market.closed ? 1 : 0,
          market.resolved ? 1 : 0,
          market.startDate,
          market.endDate,
          market.volume,
          market.liquidity,
          JSON.stringify(market.outcomes),
          JSON.stringify(market.outcomePrices),
          market.enableOrderBook ? 1 : 0,
          market.bestBid,
          market.bestAsk,
          market.lastTradePrice,
          market.sourceUpdatedAt,
          market.url,
          new Date().toISOString(),
        ),
    );
  }

  for (const snap of result.priceSnapshots) {
    statements.push(
      db
        .prepare(
          `INSERT INTO poly_price_snapshots
           (run_id, market_id, token_id, best_bid, best_ask, mid, spread, last_trade_price, source, source_timestamp, ingested_at, stale_age_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          result.run.id,
          snap.marketId,
          snap.tokenId,
          snap.bestBid,
          snap.bestAsk,
          snap.mid,
          snap.spread,
          snap.lastTradePrice,
          snap.source,
          snap.sourceTimestamp,
          snap.ingestedAt,
          snap.staleAgeMs,
        ),
    );
  }

  for (const book of result.orderBooks) {
    statements.push(
      db
        .prepare(
          `INSERT INTO poly_order_book_snapshots
           (run_id, market_id, token_id, last_trade_price, source_timestamp, ingested_at, bids_json, asks_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          result.run.id,
          book.marketId,
          book.tokenId,
          book.lastTradePrice,
          book.sourceTimestamp,
          book.ingestedAt,
          JSON.stringify(book.bids),
          JSON.stringify(book.asks),
        ),
    );
  }

  for (const trade of result.trades) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO poly_trades
           (id, run_id, market_id, condition_id, token_id, side, price, size, outcome, trader_name, transaction_hash, traded_at, ingested_at, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          trade.id,
          result.run.id,
          trade.marketId,
          trade.conditionId,
          trade.tokenId,
          trade.side,
          trade.price,
          trade.size,
          trade.outcome,
          trade.traderName,
          trade.transactionHash,
          trade.tradedAt,
          trade.ingestedAt,
          trade.source,
        ),
    );
  }

  const chunkSize = 50;
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize));
  }
}

export const polyIngestionTableStatements = [
  `CREATE TABLE IF NOT EXISTS poly_ingestion_runs (
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
  )`,
  `CREATE TABLE IF NOT EXISTS poly_markets (
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
  )`,
  `CREATE TABLE IF NOT EXISTS poly_price_snapshots (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_poly_price_snapshots_market ON poly_price_snapshots(market_id, ingested_at)`,
  `CREATE TABLE IF NOT EXISTS poly_order_book_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    market_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    last_trade_price REAL,
    source_timestamp TEXT,
    ingested_at TEXT NOT NULL,
    bids_json TEXT NOT NULL,
    asks_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS poly_trades (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_poly_trades_market ON poly_trades(market_id, traded_at)`,
];