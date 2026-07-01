import { pruneKalshiIngest } from "./kalshi-ingest.ts";
import { pruneObservations } from "./storage.ts";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_STATE_KEY = "last_d1_cleanup_at";

export interface D1CleanupResult {
  ran_at: string;
  skipped: boolean;
  retention_days: number;
  tables: Record<string, number>;
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

async function tableCount(db: D1Database, table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first<{ c: number }>();
  return row?.c ?? 0;
}

export async function shouldRunD1DailyCleanup(db: D1Database, now = Date.now()): Promise<boolean> {
  const last = await getState(db, CLEANUP_STATE_KEY);
  if (!last) return true;
  const lastMs = new Date(last).getTime();
  if (Number.isNaN(lastMs)) return true;
  return now - lastMs >= CLEANUP_INTERVAL_MS;
}

export async function runD1Cleanup(db: D1Database, retentionDays: number): Promise<D1CleanupResult> {
  const ranAt = new Date().toISOString();
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  const before: Record<string, number> = {
    poly_price_snapshots: await tableCount(db, "poly_price_snapshots"),
    poly_order_book_snapshots: await tableCount(db, "poly_order_book_snapshots"),
    poly_trades: await tableCount(db, "poly_trades"),
    observations: await tableCount(db, "observations"),
    poly_ingestion_runs: await tableCount(db, "poly_ingestion_runs"),
    signals_inactive: await tableCount(db, "signals"),
  };

  await db.batch([
    db.prepare("DELETE FROM poly_price_snapshots"),
    db.prepare("DELETE FROM poly_order_book_snapshots"),
    db.prepare("DELETE FROM poly_trades"),
    db.prepare("DELETE FROM poly_ingestion_runs WHERE started_at < ?").bind(cutoff),
    db.prepare("DELETE FROM signals WHERE is_active = 0 AND created_at < ?").bind(cutoff),
  ]);

  await pruneObservations(db, retentionDays);
  await pruneKalshiIngest(db, retentionDays);

  const after: Record<string, number> = {
    poly_price_snapshots: await tableCount(db, "poly_price_snapshots"),
    poly_order_book_snapshots: await tableCount(db, "poly_order_book_snapshots"),
    poly_trades: await tableCount(db, "poly_trades"),
    observations: await tableCount(db, "observations"),
    poly_ingestion_runs: await tableCount(db, "poly_ingestion_runs"),
    signals_inactive: await tableCount(db, "signals"),
  };

  const tables: Record<string, number> = {};
  for (const key of Object.keys(before)) {
    tables[key] = Math.max(0, before[key]! - after[key]!);
  }

  await setState(db, CLEANUP_STATE_KEY, ranAt);

  return { ran_at: ranAt, skipped: false, retention_days: retentionDays, tables };
}

export async function runD1DailyCleanupIfDue(
  db: D1Database,
  retentionDays: number,
): Promise<D1CleanupResult | null> {
  if (!(await shouldRunD1DailyCleanup(db))) return null;
  return runD1Cleanup(db, retentionDays);
}