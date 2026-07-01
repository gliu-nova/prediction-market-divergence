-- Manual / one-shot D1 cleanup (matches src/cleanup-d1.ts defaults: 30-day retention).
DELETE FROM poly_price_snapshots;
DELETE FROM poly_order_book_snapshots;
DELETE FROM poly_trades;
DELETE FROM poly_ingestion_runs WHERE started_at < datetime('now', '-30 days');
DELETE FROM signals WHERE is_active = 0 AND created_at < datetime('now', '-30 days');
DELETE FROM observations WHERE observed_at < datetime('now', '-30 days');
DELETE FROM kalshi_raw_pages WHERE poll_ts IN (
  SELECT poll_ts FROM kalshi_ingest_batches WHERE created_at < datetime('now', '-30 days')
);
DELETE FROM kalshi_normalized_markets WHERE poll_ts IN (
  SELECT poll_ts FROM kalshi_ingest_batches WHERE created_at < datetime('now', '-30 days')
);
DELETE FROM kalshi_ingest_batches WHERE created_at < datetime('now', '-30 days');
INSERT INTO poll_state (key, value) VALUES ('last_d1_cleanup_at', datetime('now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value;