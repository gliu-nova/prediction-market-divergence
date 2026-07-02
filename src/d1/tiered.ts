import type { CanonicalMarket, MatchedPair, Signal } from "../types.ts";

const MAX_D1_TEXT_BYTES = 2000;
const BATCH_CHUNK = 40;

function truncate(value: string, maxBytes = MAX_D1_TEXT_BYTES): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && encoder.encode(value.slice(0, end)).length > maxBytes) end -= 1;
  return value.slice(0, end);
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK));
  }
}

export const tieredTableStatements = [
  `CREATE TABLE IF NOT EXISTS markets (
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
  )`,
  "CREATE INDEX IF NOT EXISTS idx_markets_match_key ON markets(match_key)",
  "CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(active, venue)",
  `CREATE TABLE IF NOT EXISTS latest_prices (
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
  )`,
  "CREATE INDEX IF NOT EXISTS idx_latest_prices_observed ON latest_prices(observed_at DESC)",
  `CREATE TABLE IF NOT EXISTS opportunity_events (
    id TEXT PRIMARY KEY,
    match_key TEXT NOT NULL,
    topic TEXT NOT NULL,
    title TEXT NOT NULL,
    difference_pct_points REAL NOT NULL,
    score INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    resolved_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_opportunity_events_detected ON opportunity_events(detected_at DESC)",
  `CREATE TABLE IF NOT EXISTS bot_posts (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT,
    tweet_text TEXT NOT NULL,
    posted_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'posted'
  )`,
  `CREATE TABLE IF NOT EXISTS indicator_summaries (
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
  )`,
  "CREATE INDEX IF NOT EXISTS idx_indicator_summaries_match ON indicator_summaries(match_key, computed_at DESC)",
  `CREATE TABLE IF NOT EXISTS cooldowns (
    key TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_cooldowns_expires ON cooldowns(expires_at)",
];

export async function upsertMarkets(db: D1Database, markets: CanonicalMarket[], now: string): Promise<number> {
  if (!markets.length) return 0;
  const statements = markets.map((m) =>
    db
      .prepare(
        `INSERT INTO markets
         (venue, market_id, canonical_id, title, topic, url, match_key, active, discovered_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(venue, market_id) DO UPDATE SET
           canonical_id = excluded.canonical_id,
           title = excluded.title,
           topic = excluded.topic,
           url = excluded.url,
           match_key = excluded.match_key,
           active = 1,
           updated_at = excluded.updated_at`,
      )
      .bind(
        m.venue,
        m.market_id,
        m.canonical_id,
        truncate(m.title),
        truncate(m.topic, 200),
        truncate(m.url, 500),
        truncate(m.match_key, 200),
        now,
        now,
      ),
  );
  await runBatches(db, statements);
  return markets.length;
}

export async function upsertLatestPrices(
  db: D1Database,
  markets: CanonicalMarket[],
  ingestTs: string,
): Promise<number> {
  if (!markets.length) return 0;
  const statements = markets.map((m) => {
    const spread =
      m.probability != null ? null : null; // spread filled when bid/ask available from poly snapshot
    return db
      .prepare(
        `INSERT INTO latest_prices
         (venue, market_id, probability, volume, liquidity, best_bid, best_ask, spread, observed_at, ingest_ts)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
         ON CONFLICT(venue, market_id) DO UPDATE SET
           probability = excluded.probability,
           volume = excluded.volume,
           liquidity = excluded.liquidity,
           spread = excluded.spread,
           observed_at = excluded.observed_at,
           ingest_ts = excluded.ingest_ts`,
      )
      .bind(m.venue, m.market_id, m.probability, m.volume, m.liquidity, spread, m.observed_at, ingestTs);
  });
  await runBatches(db, statements);
  return markets.length;
}

export async function loadLatestPricesMarkets(db: D1Database): Promise<CanonicalMarket[]> {
  const rows = await db
    .prepare(
      `SELECT m.venue, m.market_id, m.canonical_id, m.title, m.topic, m.url, m.match_key,
              lp.probability, lp.volume, lp.liquidity, lp.observed_at
       FROM latest_prices lp
       JOIN markets m ON m.venue = lp.venue AND m.market_id = lp.market_id
       WHERE m.active = 1`,
    )
    .all<{
      venue: "kalshi" | "polymarket";
      market_id: string;
      canonical_id: string;
      title: string;
      topic: string;
      url: string;
      match_key: string;
      probability: number;
      volume: number | null;
      liquidity: number | null;
      observed_at: string;
    }>();
  return (rows.results ?? []).map((r) => ({
    canonical_id: r.canonical_id,
    title: r.title,
    topic: r.topic,
    venue: r.venue,
    market_id: r.market_id,
    probability: r.probability,
    volume: r.volume,
    liquidity: r.liquidity,
    url: r.url,
    observed_at: r.observed_at,
    match_key: r.match_key,
  }));
}

export async function recordOpportunityEvents(
  db: D1Database,
  detected: Array<{ signal: Signal; match_key: string }>,
): Promise<void> {
  if (!detected.length) return;
  const statements = detected.map(({ signal: s, match_key }) =>
    db
      .prepare(
        `INSERT INTO opportunity_events
         (id, match_key, topic, title, difference_pct_points, score, payload_json, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           difference_pct_points = excluded.difference_pct_points,
           score = excluded.score,
           payload_json = excluded.payload_json,
           detected_at = excluded.detected_at`,
      )
      .bind(
        s.id,
        truncate(match_key, 200),
        truncate(s.asset_or_topic, 200),
        truncate(s.title),
        s.difference_pct_points,
        s.score,
        JSON.stringify(s),
        s.created_at,
      ),
  );
  await runBatches(db, statements);
}

export interface IndicatorRow {
  match_key: string;
  venue: string;
  max_gap_30d: number | null;
  prob_change_1h: number | null;
  prob_change_24h: number | null;
}

export async function maxGapsFromIndicators(
  db: D1Database,
  pairs: MatchedPair[],
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (!pairs.length) return result;

  for (const pair of pairs) {
    const row = await db
      .prepare(
        `SELECT max_gap_30d FROM indicator_summaries
         WHERE match_key = ?
         ORDER BY computed_at DESC LIMIT 1`,
      )
      .bind(pair.match_key)
      .first<{ max_gap_30d: number | null }>();
    result.set(pair.match_key, row?.max_gap_30d ?? null);
  }
  return result;
}

export async function upsertIndicatorSummaries(
  db: D1Database,
  rows: Array<{
    match_key: string;
    venue: string;
    computed_at: string;
    prob_change_1h?: number | null;
    prob_change_24h?: number | null;
    max_gap_30d?: number | null;
    spread_p50?: number | null;
    volume_p50?: number | null;
    similar_events_count?: number | null;
    reversion_rate?: number | null;
    payload_json?: string | null;
  }>,
): Promise<number> {
  if (!rows.length) return 0;
  const statements = rows.map((r) =>
    db
      .prepare(
        `INSERT INTO indicator_summaries
         (match_key, venue, computed_at, prob_change_1h, prob_change_24h, max_gap_30d,
          spread_p50, volume_p50, similar_events_count, reversion_rate, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(match_key, venue, computed_at) DO UPDATE SET
           prob_change_1h = excluded.prob_change_1h,
           prob_change_24h = excluded.prob_change_24h,
           max_gap_30d = excluded.max_gap_30d,
           spread_p50 = excluded.spread_p50,
           volume_p50 = excluded.volume_p50,
           similar_events_count = excluded.similar_events_count,
           reversion_rate = excluded.reversion_rate,
           payload_json = excluded.payload_json`,
      )
      .bind(
        r.match_key,
        r.venue,
        r.computed_at,
        r.prob_change_1h ?? null,
        r.prob_change_24h ?? null,
        r.max_gap_30d ?? null,
        r.spread_p50 ?? null,
        r.volume_p50 ?? null,
        r.similar_events_count ?? null,
        r.reversion_rate ?? null,
        r.payload_json ?? null,
      ),
  );
  await runBatches(db, statements);
  return rows.length;
}

export async function setJobState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

export async function getJobState(db: D1Database, key: string): Promise<string> {
  const row = await db.prepare("SELECT value FROM poll_state WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? "";
}

export async function pruneTieredState(db: D1Database, retentionDays: number): Promise<Record<string, number>> {
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  const before = {
    opportunity_events: await countTable(db, "opportunity_events"),
    indicator_summaries: await countTable(db, "indicator_summaries"),
    bot_posts: await countTable(db, "bot_posts"),
    cooldowns: await countTable(db, "cooldowns"),
  };

  await db.batch([
    db.prepare("DELETE FROM opportunity_events WHERE detected_at < ?").bind(cutoff),
    db.prepare("DELETE FROM indicator_summaries WHERE computed_at < ?").bind(cutoff),
    db.prepare("DELETE FROM bot_posts WHERE posted_at < ?").bind(cutoff),
    db.prepare("DELETE FROM cooldowns WHERE expires_at < ?").bind(new Date().toISOString()),
  ]);

  const after = {
    opportunity_events: await countTable(db, "opportunity_events"),
    indicator_summaries: await countTable(db, "indicator_summaries"),
    bot_posts: await countTable(db, "bot_posts"),
    cooldowns: await countTable(db, "cooldowns"),
  };

  const removed: Record<string, number> = {};
  for (const k of Object.keys(before) as Array<keyof typeof before>) {
    removed[k] = Math.max(0, before[k] - after[k]);
  }
  return removed;
}

async function countTable(db: D1Database, table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first<{ c: number }>();
  return row?.c ?? 0;
}