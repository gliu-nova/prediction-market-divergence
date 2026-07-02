import { loadLatestPricesMarkets, tieredTableStatements } from "./d1/tiered.ts";
import { matchCrossVenue } from "./matcher.ts";
import { polyIngestionTableStatements } from "./polymarket/storage-d1";
import type {
  AppConfig,
  HealthStatus,
  CanonicalMarket,
  IngestedMarketRow,
  IngestedMarketsPage,
  MarketObservation,
  MatchedPair,
  MatchedPairRow,
  MatchedPairsPage,
  Opportunity,
  Signal,
  VenueBreakdown,
} from "./types";

const ALIGNMENT_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_D1_TEXT_BYTES = 2000;
const D1_BATCH_CHUNK_SIZE = 20;
const D1_IN_CLAUSE_CHUNK_SIZE = 40;

function truncateForD1(value: string, maxBytes = MAX_D1_TEXT_BYTES): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && encoder.encode(value.slice(0, end)).length > maxBytes) {
    end -= 1;
  }
  return value.slice(0, end);
}

export async function ensureTables(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS observations (
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
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_obs_canonical ON observations(canonical_id, observed_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_obs_venue ON observations(venue, market_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      score INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_signals_score ON signals(score DESC, created_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_signals_active ON signals(is_active, score DESC)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS poll_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kalshi_ingest_batches (
      poll_ts TEXT PRIMARY KEY,
      page_count INTEGER NOT NULL,
      raw_market_count INTEGER NOT NULL,
      normalized_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kalshi_raw_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_ts TEXT NOT NULL,
      page_index INTEGER NOT NULL,
      request_cursor TEXT,
      response_cursor TEXT,
      market_count INTEGER NOT NULL,
      payload TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      UNIQUE(poll_ts, page_index)
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_kalshi_raw_pages_poll_ts ON kalshi_raw_pages(poll_ts)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS kalshi_normalized_markets (
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
    )`),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_kalshi_normalized_poll_ts ON kalshi_normalized_markets(poll_ts)",
    ),
    db.prepare(`CREATE TABLE IF NOT EXISTS ingested_markets (
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
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_ingested_markets_venue ON ingested_markets(venue)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_ingested_markets_title ON ingested_markets(title)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS matched_pair_snapshots (
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
    )`),
    ...polyIngestionTableStatements.map((sql) => db.prepare(sql)),
    ...tieredTableStatements.map((sql) => db.prepare(sql)),
  ]);
}

async function getState(db: D1Database, key: string): Promise<string> {
  const row = await db.prepare("SELECT value FROM poll_state WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? "";
}

async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

async function runStatementBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += D1_BATCH_CHUNK_SIZE) {
    await db.batch(statements.slice(i, i + D1_BATCH_CHUNK_SIZE));
  }
}

export async function saveObservationsBatched(
  db: D1Database,
  observations: MarketObservation[],
): Promise<number> {
  if (!observations.length) return 0;

  const statements = observations.map((obs) =>
    db
      .prepare(
        `INSERT INTO observations
         (venue, market_id, canonical_id, title, topic, probability, volume, liquidity, url, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        obs.venue,
        obs.market_id,
        obs.canonical_id,
        truncateForD1(obs.title),
        truncateForD1(obs.topic, 200),
        obs.probability,
        obs.volume,
        obs.liquidity,
        truncateForD1(obs.url, 500),
        obs.observed_at,
      ),
  );

  await runStatementBatches(db, statements);
  return observations.length;
}

export async function saveObservations(
  db: D1Database,
  observations: MarketObservation[],
  minIntervalSeconds = 60,
): Promise<number> {
  let saved = 0;
  for (const obs of observations) {
    const prior = await db
      .prepare(
        "SELECT probability, observed_at FROM observations WHERE venue = ? AND market_id = ? ORDER BY observed_at DESC LIMIT 1",
      )
      .bind(obs.venue, obs.market_id)
      .first<{ probability: number; observed_at: string }>();

    if (prior) {
      const ageSec = (new Date(obs.observed_at).getTime() - new Date(prior.observed_at).getTime()) / 1000;
      if (ageSec < minIntervalSeconds && Math.abs(prior.probability - obs.probability) < 0.001) continue;
    }

    await db
      .prepare(
        `INSERT INTO observations
         (venue, market_id, canonical_id, title, topic, probability, volume, liquidity, url, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        obs.venue,
        obs.market_id,
        obs.canonical_id,
        truncateForD1(obs.title),
        truncateForD1(obs.topic, 200),
        obs.probability,
        obs.volume,
        obs.liquidity,
        truncateForD1(obs.url, 500),
        obs.observed_at,
      )
      .run();
    saved += 1;
  }
  return saved;
}

export async function pruneObservations(db: D1Database, retentionDays: number): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  await db.prepare("DELETE FROM observations WHERE observed_at < ?").bind(cutoff).run();
}

function computeMaxHistoricalGapFromRows(
  rows: Array<{ venue: string; probability: number; observed_at: string }>,
  venueA: string,
  venueB: string,
  excludeSince?: string,
): number | null {
  const excludeTs = excludeSince ? new Date(excludeSince).getTime() : null;
  const seriesA = rows.filter(
    (r) => r.venue === venueA && (!excludeTs || new Date(r.observed_at).getTime() < excludeTs),
  );
  const seriesB = rows.filter(
    (r) => r.venue === venueB && (!excludeTs || new Date(r.observed_at).getTime() < excludeTs),
  );
  if (!seriesA.length || !seriesB.length) return null;

  const gaps: number[] = [];
  for (const b of seriesB) {
    let bestDelta: number | null = null;
    let bestProbA: number | null = null;
    for (const a of seriesA) {
      const delta = Math.abs(new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime());
      if (delta <= ALIGNMENT_TOLERANCE_MS) {
        if (bestDelta == null || delta < bestDelta) {
          bestDelta = delta;
          bestProbA = a.probability;
        }
      }
    }
    if (bestProbA != null) gaps.push(Math.abs(bestProbA - b.probability) * 100);
  }
  return gaps.length ? Math.max(...gaps) : null;
}

export async function maxHistoricalGapsForPairs(
  db: D1Database,
  pairs: MatchedPair[],
  lookbackDays: number,
  excludeSince?: string,
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (!pairs.length) return result;

  const cutoff = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const canonicalIds = [...new Set(pairs.map((pair) => pair.match_key))];
  const rowsByCanonical = new Map<string, Array<{ venue: string; probability: number; observed_at: string }>>();

  for (let i = 0; i < canonicalIds.length; i += D1_IN_CLAUSE_CHUNK_SIZE) {
    const chunk = canonicalIds.slice(i, i + D1_IN_CLAUSE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db
      .prepare(
        `SELECT canonical_id, venue, probability, observed_at FROM observations
         WHERE observed_at >= ? AND canonical_id IN (${placeholders})
         ORDER BY observed_at ASC`,
      )
      .bind(cutoff, ...chunk)
      .all<{ canonical_id: string; venue: string; probability: number; observed_at: string }>();

    for (const row of rows.results) {
      const series = rowsByCanonical.get(row.canonical_id) ?? [];
      series.push({ venue: row.venue, probability: row.probability, observed_at: row.observed_at });
      rowsByCanonical.set(row.canonical_id, series);
    }
  }

  for (const pair of pairs) {
    const venueA = pair.market_a.venue === "kalshi" ? "Kalshi" : "Polymarket";
    const venueB = pair.market_b.venue === "kalshi" ? "Kalshi" : "Polymarket";
    const rows = rowsByCanonical.get(pair.match_key) ?? [];
    result.set(
      pair.match_key,
      computeMaxHistoricalGapFromRows(rows, venueA, venueB, excludeSince),
    );
  }

  return result;
}

export async function maxHistoricalGap(
  db: D1Database,
  canonicalId: string,
  venueA: string,
  venueB: string,
  lookbackDays: number,
  excludeSince?: string,
): Promise<number | null> {
  const cutoff = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const rows = await db
    .prepare(
      "SELECT venue, probability, observed_at FROM observations WHERE canonical_id = ? AND observed_at >= ? ORDER BY observed_at ASC",
    )
    .bind(canonicalId, cutoff)
    .all<{ venue: string; probability: number; observed_at: string }>();

  return computeMaxHistoricalGapFromRows(rows.results, venueA, venueB, excludeSince);
}

export async function syncActiveSignals(db: D1Database, signals: Signal[]): Promise<void> {
  const maxAgeCutoff = new Date(Date.now() - 24 * 3600000).toISOString();
  const activeIds = new Set(signals.map((signal) => signal.id));
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM signals WHERE is_active = 0 AND created_at < ?").bind(maxAgeCutoff),
  ];

  if (!signals.length) {
    const active = await db
      .prepare("SELECT id FROM signals WHERE is_active = 1")
      .all<{ id: string }>();
    for (const row of active.results ?? []) {
      statements.push(db.prepare("UPDATE signals SET is_active = 0 WHERE id = ?").bind(row.id));
    }
    await runStatementBatches(db, statements);
    return;
  }

  const active = await db
    .prepare("SELECT id FROM signals WHERE is_active = 1")
    .all<{ id: string }>();
  for (const row of active.results ?? []) {
    if (!activeIds.has(row.id)) {
      statements.push(db.prepare("UPDATE signals SET is_active = 0 WHERE id = ?").bind(row.id));
    }
  }

  for (const signal of signals) {
    statements.push(
      db
        .prepare(
          `INSERT INTO signals (id, type, payload, score, is_active, created_at)
           VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, score = excluded.score, is_active = 1, created_at = excluded.created_at`,
        )
        .bind(signal.id, signal.type, JSON.stringify(signal), signal.score, signal.created_at),
    );
  }

  await runStatementBatches(db, statements);
}

function parseSignal(row: { payload: string }): Signal {
  return JSON.parse(row.payload) as Signal;
}

export async function getSignals(
  db: D1Database,
  opts: {
    minScore?: number;
    minDifferencePctPoints?: number;
    minVolume?: number;
    venue?: string;
    topic?: string;
    limit?: number;
    activeOnly?: boolean;
  } = {},
): Promise<Signal[]> {
  const {
    minScore = 0,
    minDifferencePctPoints = 0,
    minVolume = 0,
    venue,
    topic,
    limit = 50,
    activeOnly = true,
  } = opts;

  const rows = await db
    .prepare(
      `SELECT payload FROM signals
       WHERE (? = 0 OR is_active = 1) AND score >= ?
       ORDER BY score DESC, created_at DESC
       LIMIT 200`,
    )
    .bind(activeOnly ? 1 : 0, minScore)
    .all<{ payload: string }>();

  const results: Signal[] = [];
  for (const row of rows.results) {
    const signal = parseSignal(row);
    if ((signal.difference_pct_points ?? 0) < minDifferencePctPoints) continue;
    const volA = signal.market_a.volume ?? 0;
    const volB = signal.market_b?.volume ?? 0;
    if (Math.max(volA, volB) < minVolume) continue;
    if (venue) {
      const v = venue.toLowerCase();
      const venues = [signal.market_a.venue.toLowerCase(), signal.market_b?.venue.toLowerCase() ?? ""];
      if (!venues.includes(v)) continue;
    }
    if (topic && !signal.asset_or_topic.toLowerCase().includes(topic.toLowerCase())) continue;
    results.push(signal);
    if (results.length >= limit) break;
  }
  return results;
}

export async function getOpportunities(
  db: D1Database,
  opts: Parameters<typeof getSignals>[1] = {},
): Promise<Opportunity[]> {
  const signals = await getSignals(db, opts);
  return signals.map((s) => ({
    ...s,
    detected_at: s.created_at,
    min_volume: Math.min(s.market_a.volume ?? 0, s.market_b?.volume ?? 0) || Math.max(s.market_a.volume ?? 0, s.market_b?.volume ?? 0),
  }));
}

export async function getSignalById(db: D1Database, id: string): Promise<Signal | null> {
  const row = await db.prepare("SELECT payload FROM signals WHERE id = ?").bind(id).first<{ payload: string }>();
  return row ? parseSignal(row) : null;
}

async function latestPolymarketRunStats(
  db: D1Database,
): Promise<{ markets_enriched: number | null; snapshots_stored: number | null }> {
  const enriched = parseInt((await getState(db, "last_poly_markets_enriched")) || "", 10);
  const snapshots = parseInt((await getState(db, "last_poly_snapshots_stored")) || "", 10);
  return {
    markets_enriched: Number.isFinite(enriched) ? enriched : null,
    snapshots_stored: Number.isFinite(snapshots) ? snapshots : null,
  };
}

async function signalCountsByVenue(
  db: D1Database,
): Promise<{ kalshi: { active: number; total: number }; polymarket: { active: number; total: number } }> {
  const rows = await db
    .prepare("SELECT payload, is_active FROM signals")
    .all<{ payload: string; is_active: number }>();

  const counts = {
    kalshi: { active: 0, total: 0 },
    polymarket: { active: 0, total: 0 },
  };

  for (const row of rows.results ?? []) {
    const signal = parseSignal(row);
    const venues = new Set<string>([signal.market_a.venue, signal.market_b?.venue].filter(Boolean) as string[]);
    for (const venue of venues) {
      if (venue !== "kalshi" && venue !== "polymarket") continue;
      counts[venue].total += 1;
      if (row.is_active) counts[venue].active += 1;
    }
  }

  return counts;
}

function buildVenueBreakdown(
  venue: "kalshi" | "polymarket",
  ingested: number,
  inPairs: number,
  enriched: number | null,
  snapshots: number | null,
  signalCounts: { active: number; total: number },
): VenueBreakdown {
  return {
    markets_ingested: ingested,
    markets_in_pairs: inPairs,
    markets_enriched: venue === "polymarket" ? enriched : null,
    snapshots_stored: venue === "polymarket" ? snapshots : null,
    active_signals: signalCounts.active,
    signals_total: signalCounts.total,
  };
}

export async function getHealth(
  db: D1Database,
  config: AppConfig,
  environment = "production",
  kalshiAuth: "missing" | "invalid" | "configured" = "missing",
): Promise<HealthStatus> {
  const lastPollAt = (await getState(db, "last_poll_at")) || null;
  const marketsTracked = parseInt((await getState(db, "last_markets_ingested")) || "0", 10);
  const matchedPairs = parseInt((await getState(db, "last_pairs_matched")) || "0", 10);
  const kalshiMarkets = parseInt((await getState(db, "last_kalshi_markets")) || "0", 10);
  const polymarketMarkets = parseInt((await getState(db, "last_polymarket_markets")) || "0", 10);
  const lastOpportunitiesFound = parseInt((await getState(db, "last_opportunities_found")) || "0", 10);
  const lastError = await getState(db, "last_error");
  const activeRow = await db
    .prepare("SELECT COUNT(*) AS c FROM signals WHERE is_active = 1")
    .first<{ c: number }>();
  const totalRow = await db.prepare("SELECT COUNT(*) AS c FROM signals").first<{ c: number }>();
  const activeOpportunities = activeRow?.c ?? 0;
  const signalsTotal = totalRow?.c ?? 0;

  const [polyRunStats, signalByVenue] = await Promise.all([
    latestPolymarketRunStats(db),
    signalCountsByVenue(db),
  ]);

  const kalshiIngested = kalshiMarkets;
  const polymarketIngested = polymarketMarkets;

  return {
    status: lastError ? "degraded" : "ok",
    last_poll_at: lastPollAt,
    last_error: lastError || null,
    markets_tracked: marketsTracked,
    active_opportunities: activeOpportunities,
    signals_total: signalsTotal,
    ingestion: {
      total_markets: marketsTracked,
      kalshi_markets: kalshiMarkets,
      polymarket_markets: polymarketMarkets,
      matched_pairs: matchedPairs,
    },
    output: {
      active_opportunities: activeOpportunities,
      signals_total: signalsTotal,
      last_opportunities_found: lastOpportunitiesFound,
    },
    venues: {
      kalshi: buildVenueBreakdown(
        "kalshi",
        kalshiIngested,
        matchedPairs,
        null,
        null,
        signalByVenue.kalshi,
      ),
      polymarket: buildVenueBreakdown(
        "polymarket",
        polymarketIngested,
        matchedPairs,
        polyRunStats.markets_enriched,
        polyRunStats.snapshots_stored,
        signalByVenue.polymarket,
      ),
    },
    sources: {
      kalshi: "ok",
      kalshi_auth: kalshiAuth,
      polymarket: "ok",
      mode: config.useMock ? "mock" : "live",
      runtime: "cloudflare-pages",
      environment,
    },
  };
}

/** Lightweight ingest metadata — no per-market D1 snapshot tables. */
export async function recordIngestStats(
  db: D1Database,
  ingestTs: string,
  result: {
    markets?: number;
    pairs?: number;
    kalshi_markets?: number;
    polymarket_markets?: number;
    prices_written?: number;
    poly_markets_enriched?: number | null;
    poly_snapshots_stored?: number | null;
  },
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db
      .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind("last_ingestion_snapshot_ts", ingestTs),
  ];

  if (result.markets != null) {
    statements.push(
      db
        .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind("last_markets_ingested", String(result.markets)),
    );
  }
  if (result.pairs != null) {
    statements.push(
      db
        .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind("last_pairs_matched", String(result.pairs)),
    );
  }
  if (result.kalshi_markets != null) {
    statements.push(
      db
        .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind("last_kalshi_markets", String(result.kalshi_markets)),
    );
  }
  if (result.polymarket_markets != null) {
    statements.push(
      db
        .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind("last_polymarket_markets", String(result.polymarket_markets)),
    );
  }
  if (result.prices_written != null) {
    statements.push(
      db
        .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind("last_prices_written", String(result.prices_written)),
    );
  }

  if (result.poly_markets_enriched != null) {
    statements.push(
      db
        .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind("last_poly_markets_enriched", String(result.poly_markets_enriched)),
    );
  }
  if (result.poly_snapshots_stored != null) {
    statements.push(
      db
        .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind("last_poly_snapshots_stored", String(result.poly_snapshots_stored)),
    );
  }

  await runStatementBatches(db, statements);
}

function ingestionSearchClause(search?: string): { sql: string; binds: string[] } {
  if (!search?.trim()) return { sql: "", binds: [] };
  const pattern = `%${search.trim()}%`;
  return {
    sql: " AND (title LIKE ? OR topic LIKE ? OR market_id LIKE ? OR match_key LIKE ?)",
    binds: [pattern, pattern, pattern, pattern],
  };
}

export async function listIngestedMarkets(
  db: D1Database,
  opts: { venue?: string; search?: string; offset?: number; limit?: number } = {},
): Promise<IngestedMarketsPage> {
  const pollTs = (await getState(db, "last_ingestion_snapshot_ts")) || null;
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const venue = opts.venue?.trim().toLowerCase();
  const venueClause =
    venue === "kalshi" || venue === "polymarket" ? " AND m.venue = ?" : "";
  const search = ingestionSearchClause(opts.search);
  const searchSql = search.sql
    ? search.sql.replaceAll("title", "m.title")
        .replaceAll("topic", "m.topic")
        .replaceAll("market_id", "m.market_id")
        .replaceAll("match_key", "m.match_key")
    : "";
  const where = `WHERE m.active = 1${venueClause}${searchSql}`;
  const binds: Array<string | number> = [];
  if (venueClause) binds.push(venue!);
  binds.push(...search.binds);

  const countRow = await db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM markets m
       INNER JOIN latest_prices lp ON lp.venue = m.venue AND lp.market_id = m.market_id
       ${where}`,
    )
    .bind(...binds)
    .first<{ c: number }>();

  const venueRows = await db
    .prepare(
      `SELECT m.venue, COUNT(*) AS c
       FROM markets m
       INNER JOIN latest_prices lp ON lp.venue = m.venue AND lp.market_id = m.market_id
       WHERE m.active = 1
       GROUP BY m.venue`,
    )
    .all<{ venue: string; c: number }>();
  const venueCounts = { kalshi: 0, polymarket: 0 };
  for (const row of venueRows.results ?? []) {
    if (row.venue === "kalshi") venueCounts.kalshi = row.c;
    if (row.venue === "polymarket") venueCounts.polymarket = row.c;
  }

  const rows = await db
    .prepare(
      `SELECT m.venue, m.market_id, m.title, m.topic, lp.probability, lp.volume, lp.liquidity,
              m.url, m.match_key, lp.observed_at
       FROM markets m
       INNER JOIN latest_prices lp ON lp.venue = m.venue AND lp.market_id = m.market_id
       ${where}
       ORDER BY m.venue ASC, m.title ASC
       LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all<IngestedMarketRow>();

  return {
    poll_ts: pollTs,
    total: countRow?.c ?? 0,
    offset,
    limit,
    venue_counts: venueCounts,
    markets: rows.results ?? [],
  };
}

export async function listMatchedPairSnapshots(
  db: D1Database,
  opts: { search?: string; offset?: number; limit?: number } = {},
): Promise<MatchedPairsPage> {
  const pollTs = (await getState(db, "last_ingestion_snapshot_ts")) || null;
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const search = opts.search?.trim().toLowerCase();

  const markets = await loadLatestPricesMarkets(db);
  let pairs = matchCrossVenue(markets);
  if (search) {
    pairs = pairs.filter(
      (pair) =>
        pair.title.toLowerCase().includes(search) ||
        pair.topic.toLowerCase().includes(search) ||
        pair.match_key.toLowerCase().includes(search) ||
        pair.market_a.title.toLowerCase().includes(search) ||
        pair.market_b.title.toLowerCase().includes(search),
    );
  }
  pairs.sort((a, b) => a.title.localeCompare(b.title));
  const page = pairs.slice(offset, offset + limit);

  const matchedRows: MatchedPairRow[] = page.map((pair) => ({
    match_key: pair.match_key,
    topic: pair.topic,
    title: pair.title,
    market_a: {
      venue: pair.market_a.venue,
      market_id: pair.market_a.market_id,
      title: pair.market_a.title,
      probability: pair.market_a.probability,
      url: pair.market_a.url,
    },
    market_b: {
      venue: pair.market_b.venue,
      market_id: pair.market_b.market_id,
      title: pair.market_b.title,
      probability: pair.market_b.probability,
      url: pair.market_b.url,
    },
  }));

  return {
    poll_ts: pollTs,
    total: pairs.length,
    offset,
    limit,
    pairs: matchedRows,
  };
}

export async function recordDetectResult(
  db: D1Database,
  result: {
    opportunities: number;
    pairs: number;
    error?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind("last_poll_at", now),
    db
      .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind("last_pairs_matched", String(result.pairs)),
    db
      .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind("last_opportunities_found", String(result.opportunities)),
    db
      .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind("last_error", result.error ?? ""),
  ]);
}

export async function recordPollResult(
  db: D1Database,
  result: {
    markets: number;
    pairs: number;
    opportunities: number;
    kalshi_markets?: number;
    polymarket_markets?: number;
    error?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind("last_poll_at", now),
    db
      .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind("last_markets_ingested", String(result.markets)),
    db
      .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind("last_pairs_matched", String(result.pairs)),
    db
      .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind("last_kalshi_markets", String(result.kalshi_markets ?? 0)),
    db
      .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind("last_polymarket_markets", String(result.polymarket_markets ?? 0)),
    db
      .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind("last_opportunities_found", String(result.opportunities)),
    db
      .prepare("INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind("last_error", result.error ?? ""),
  ]);
}