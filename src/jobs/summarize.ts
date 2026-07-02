import { getJobState, setJobState } from "../d1/tiered.ts";
import { ensureTables } from "../storage.ts";
import type { Env } from "../types.ts";

export interface SummarizeResult {
  active_markets: number;
  active_opportunities: number;
  latest_prices: number;
  opportunity_events_24h: number;
  indicator_rows: number;
}

export async function runSummarize(env: Env): Promise<SummarizeResult> {
  const now = new Date().toISOString();
  const cutoff24h = new Date(Date.now() - 24 * 3600000).toISOString();
  await ensureTables(env.DB);

  const [activeMarkets, latestPrices, activeOpps, events24h, indicators] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS c FROM markets WHERE active = 1").first<{ c: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM latest_prices").first<{ c: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM signals WHERE is_active = 1").first<{ c: number }>(),
    env.DB
      .prepare("SELECT COUNT(*) AS c FROM opportunity_events WHERE detected_at >= ?")
      .bind(cutoff24h)
      .first<{ c: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM indicator_summaries").first<{ c: number }>(),
  ]);

  await setJobState(env.DB, "last_summarize_at", now);
  await setJobState(env.DB, "summary_active_markets", String(activeMarkets?.c ?? 0));
  await setJobState(env.DB, "summary_active_opportunities", String(activeOpps?.c ?? 0));

  const lastDiscover = await getJobState(env.DB, "last_discover_at");
  const lastIngest = await getJobState(env.DB, "last_ingest_at");
  const lastDetect = await getJobState(env.DB, "last_detect_at");
  await setJobState(
    env.DB,
    "summary_job_freshness",
    JSON.stringify({ last_discover_at: lastDiscover, last_ingest_at: lastIngest, last_detect_at: lastDetect }),
  );

  return {
    active_markets: activeMarkets?.c ?? 0,
    active_opportunities: activeOpps?.c ?? 0,
    latest_prices: latestPrices?.c ?? 0,
    opportunity_events_24h: events24h?.c ?? 0,
    indicator_rows: indicators?.c ?? 0,
  };
}