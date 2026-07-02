import { runD1DailyCleanupIfDue } from "./cleanup-d1";
import { loadConfig } from "./config";
import { runDetectOpportunities } from "./jobs/detect-opportunities.ts";
import { runDiscoverMarkets } from "./jobs/discover-markets.ts";
import { runIngestSnapshots } from "./jobs/ingest-snapshots.ts";
import { runSummarize } from "./jobs/summarize.ts";
import { ensureTables, recordPollResult } from "./storage";
import type { Env } from "./types";

export interface PollResult {
  markets: number;
  pairs: number;
  opportunities: number;
}

/** Full pipeline: ingest + detect (backward-compatible with POST /poll). */
export async function runPoll(env: Env): Promise<PollResult> {
  const config = loadConfig(env);
  try {
    await ensureTables(env.DB);
    await runD1DailyCleanupIfDue(env.DB, config.observationRetentionDays);

    const ingest = await runIngestSnapshots(env);
    const detect = await runDetectOpportunities(env);

    return {
      markets: ingest.markets,
      pairs: ingest.pairs,
      opportunities: detect.opportunities,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordPollResult(env.DB, {
      markets: 0,
      pairs: 0,
      opportunities: 0,
      kalshi_markets: 0,
      polymarket_markets: 0,
      error: message,
    });
    throw err;
  }
}

export { runDiscoverMarkets, runIngestSnapshots, runDetectOpportunities, runSummarize };