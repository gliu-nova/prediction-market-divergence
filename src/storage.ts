import type { AppConfig, HealthStatus, MarketObservation, Opportunity, Signal } from "./types";

const ALIGNMENT_TOLERANCE_MS = 5 * 60 * 1000;

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
        obs.title,
        obs.topic,
        obs.probability,
        obs.volume,
        obs.liquidity,
        obs.url,
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

export async function maxHistoricalGap(
  db: D1Database,
  canonicalId: string,
  venueA: string,
  venueB: string,
  lookbackDays: number,
  excludeSince?: string,
): Promise<number | null> {
  const cutoff = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const excludeTs = excludeSince ? new Date(excludeSince).getTime() : null;

  const rows = await db
    .prepare(
      "SELECT venue, probability, observed_at FROM observations WHERE canonical_id = ? AND observed_at >= ? ORDER BY observed_at ASC",
    )
    .bind(canonicalId, cutoff)
    .all<{ venue: string; probability: number; observed_at: string }>();

  const seriesA = rows.results.filter(
    (r) => r.venue === venueA && (!excludeTs || new Date(r.observed_at).getTime() < excludeTs),
  );
  const seriesB = rows.results.filter(
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

export async function syncActiveSignals(db: D1Database, signals: Signal[]): Promise<void> {
  const activeIds = new Set(signals.map((s) => s.id));
  const now = new Date().toISOString();

  for (const signal of signals) {
    await db
      .prepare(
        `INSERT INTO signals (id, type, payload, score, is_active, created_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, score = excluded.score, is_active = 1, created_at = excluded.created_at`,
      )
      .bind(signal.id, signal.type, JSON.stringify(signal), signal.score, signal.created_at)
      .run();
  }

  const activeRows = await db
    .prepare("SELECT id FROM signals WHERE is_active = 1")
    .all<{ id: string }>();

  const stale = activeRows.results.map((r) => r.id).filter((id) => !activeIds.has(id));
  if (stale.length) {
    const placeholders = stale.map(() => "?").join(",");
    await db.prepare(`UPDATE signals SET is_active = 0 WHERE id IN (${placeholders})`).bind(...stale).run();
  }

  const maxAgeCutoff = new Date(Date.now() - 24 * 3600000).toISOString();
  await db.prepare("DELETE FROM signals WHERE is_active = 0 AND created_at < ?").bind(maxAgeCutoff).run();
  await setState(db, "signals_synced_at", now);
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

export async function getHealth(
  db: D1Database,
  config: AppConfig,
  environment = "production",
): Promise<HealthStatus> {
  const lastPollAt = (await getState(db, "last_poll_at")) || null;
  const marketsTracked = parseInt((await getState(db, "last_markets_ingested")) || "0", 10);
  const lastError = await getState(db, "last_error");
  const activeRow = await db
    .prepare("SELECT COUNT(*) AS c FROM signals WHERE is_active = 1")
    .first<{ c: number }>();
  const totalRow = await db.prepare("SELECT COUNT(*) AS c FROM signals").first<{ c: number }>();

  return {
    status: lastError ? "degraded" : "ok",
    last_poll_at: lastPollAt,
    markets_tracked: marketsTracked,
    active_opportunities: activeRow?.c ?? 0,
    signals_total: totalRow?.c ?? 0,
    sources: {
      kalshi: "ok",
      polymarket: "ok",
      mode: config.useMock ? "mock" : "live",
      runtime: "cloudflare-pages",
      environment,
    },
  };
}

export async function recordPollResult(
  db: D1Database,
  result: { markets: number; pairs: number; opportunities: number; error?: string },
): Promise<void> {
  const now = new Date().toISOString();
  await setState(db, "last_poll_at", now);
  await setState(db, "last_markets_ingested", String(result.markets));
  await setState(db, "last_opportunities_found", String(result.opportunities));
  await setState(db, "last_error", result.error ?? "");
}