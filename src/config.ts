import type { AppConfig, Env } from "./types";

export function loadConfig(env: Env): AppConfig {
  return {
    useMock: (env.USE_MOCK ?? "false").toLowerCase() === "true",
    minDivergencePctPoints: parseFloat(env.MIN_DIVERGENCE_PCT_POINTS ?? "5"),
    minVolume: parseFloat(env.MIN_VOLUME ?? "1000"),
    lookbackDays: parseInt(env.LOOKBACK_DAYS ?? "30", 10),
    opportunityMaxAgeHours: parseInt(env.OPPORTUNITY_MAX_AGE_HOURS ?? "24", 10),
    observationRetentionDays: parseInt(env.OBSERVATION_RETENTION_DAYS ?? "30", 10),
    scoring: {
      weightDifference: 0.4,
      weightLiquidity: 0.25,
      weightRecency: 0.2,
      weightRarity: 0.15,
    },
  };
}