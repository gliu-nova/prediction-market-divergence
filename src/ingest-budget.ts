/**
 * Hard caps for one Pages Function invocation.
 * The isolate has 128MB of memory. A single Kalshi page is ~2.4MB of JSON
 * and about 43 fields per market, so unbounded catalog fetches get killed
 * with Cloudflare error 1102.
 */

export const KALSHI_MAX_PAGES = 2;
export const KALSHI_MAX_PAGES_CEILING = 3;
export const KALSHI_MAX_MARKETS = 400;
export const KALSHI_MAX_MARKETS_CEILING = 500;

export const POLYMARKET_MAX_MARKETS = 100;
export const POLYMARKET_MAX_MARKETS_CEILING = 100;
export const POLYMARKET_MAX_GAMMA_PAGES = 2;
export const POLYMARKET_MAX_GAMMA_PAGES_CEILING = 2;

export interface IngestBudget {
  kalshiMaxPages: number;
  kalshiMaxMarkets: number;
  polymarketMaxMarkets: number;
  polymarketMaxGammaPages: number;
}

export function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function ingestBudgetFromEnv(env: {
  KALSHI_MAX_PAGES?: string;
  KALSHI_MAX_MARKETS?: string;
  POLYMARKET_MAX_MARKETS?: string;
  POLYMARKET_MAX_GAMMA_PAGES?: string;
}): IngestBudget {
  return {
    kalshiMaxPages: clampInt(
      parseInt(env.KALSHI_MAX_PAGES ?? "", 10),
      1,
      KALSHI_MAX_PAGES_CEILING,
      KALSHI_MAX_PAGES,
    ),
    kalshiMaxMarkets: clampInt(
      parseInt(env.KALSHI_MAX_MARKETS ?? "", 10),
      1,
      KALSHI_MAX_MARKETS_CEILING,
      KALSHI_MAX_MARKETS,
    ),
    polymarketMaxMarkets: clampInt(
      parseInt(env.POLYMARKET_MAX_MARKETS ?? "", 10),
      1,
      POLYMARKET_MAX_MARKETS_CEILING,
      POLYMARKET_MAX_MARKETS,
    ),
    polymarketMaxGammaPages: clampInt(
      parseInt(env.POLYMARKET_MAX_GAMMA_PAGES ?? "", 10),
      1,
      POLYMARKET_MAX_GAMMA_PAGES_CEILING,
      POLYMARKET_MAX_GAMMA_PAGES,
    ),
  };
}

/** Drop Polymarket text blobs the matcher never reads. */
export function slimPolymarketRaw(row: Record<string, unknown>): Record<string, unknown> {
  const slim: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value == null) continue;
    if (key === "description" || key === "events" || key === "tags") continue;
    slim[key] = value;
  }
  return slim;
}

export function capByVolume<T>(items: readonly T[], max: number, volumeOf: (item: T) => number): T[] {
  if (items.length <= max) return [...items];
  return [...items].sort((a, b) => volumeOf(b) - volumeOf(a)).slice(0, max);
}
