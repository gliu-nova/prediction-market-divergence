import type { CanonicalMarket } from "./types";
import type { KalshiIngestPage } from "./sources/kalshi";

const D1_BATCH_CHUNK_SIZE = 200;

export interface KalshiIngestBatch {
  pollTs: string;
  pageCount: number;
  rawMarketCount: number;
  normalizedCount: number;
}

async function runStatementBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += D1_BATCH_CHUNK_SIZE) {
    await db.batch(statements.slice(i, i + D1_BATCH_CHUNK_SIZE));
  }
}

export async function saveKalshiIngest(
  db: D1Database,
  pollTs: string,
  pages: KalshiIngestPage[],
  normalized: CanonicalMarket[],
): Promise<KalshiIngestBatch> {
  const rawMarketCount = pages.reduce((sum, page) => sum + page.marketCount, 0);
  const createdAt = new Date().toISOString();
  const batch: KalshiIngestBatch = {
    pollTs,
    pageCount: pages.length,
    rawMarketCount,
    normalizedCount: normalized.length,
  };

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO kalshi_ingest_batches (poll_ts, page_count, raw_market_count, normalized_count, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(poll_ts) DO UPDATE SET
           page_count = excluded.page_count,
           raw_market_count = excluded.raw_market_count,
           normalized_count = excluded.normalized_count,
           created_at = excluded.created_at`,
      )
      .bind(pollTs, batch.pageCount, batch.rawMarketCount, batch.normalizedCount, createdAt),
    db.prepare("DELETE FROM kalshi_normalized_markets WHERE poll_ts = ?").bind(pollTs),
  ];

  for (const market of normalized) {
    statements.push(
      db
        .prepare(
          `INSERT INTO kalshi_normalized_markets
           (poll_ts, market_id, canonical_id, title, topic, probability, volume, liquidity, url, match_key, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          pollTs,
          market.market_id,
          market.canonical_id,
          market.title,
          market.topic,
          market.probability,
          market.volume,
          market.liquidity,
          market.url,
          market.match_key,
          market.observed_at,
        ),
    );
  }

  await runStatementBatches(db, statements);
  return batch;
}

export async function pruneKalshiIngest(db: D1Database, retentionDays: number): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  const oldBatches = await db
    .prepare("SELECT poll_ts FROM kalshi_ingest_batches WHERE created_at < ?")
    .bind(cutoff)
    .all<{ poll_ts: string }>();

  for (const row of oldBatches.results) {
    await db.batch([
      db.prepare("DELETE FROM kalshi_raw_pages WHERE poll_ts = ?").bind(row.poll_ts),
      db.prepare("DELETE FROM kalshi_normalized_markets WHERE poll_ts = ?").bind(row.poll_ts),
      db.prepare("DELETE FROM kalshi_ingest_batches WHERE poll_ts = ?").bind(row.poll_ts),
    ]);
  }
}