import type { AppConfig, CanonicalMarket } from "./types";

export function scoreDivergence(
  config: AppConfig,
  differencePctPoints: number,
  marketA: CanonicalMarket,
  marketB: CanonicalMarket,
  maxHistoricalGap: number | null,
  observedAt: string,
): number {
  const diffScore = Math.min(100, (differencePctPoints / 15) * 100);

  const volA = marketA.volume ?? 0;
  const volB = marketB.volume ?? 0;
  const liquidity = Math.max(volA, volB);
  const liqScore = liquidity > 0 ? Math.min(100, (Math.log10(liquidity + 1) / 6) * 100) : 20;

  const ageMinutes = (Date.now() - new Date(observedAt).getTime()) / 60000;
  let recencyScore = 100;
  if (ageMinutes > 30) {
    const ageHours = ageMinutes / 60;
    recencyScore = Math.max(0, 100 - (ageHours - 0.5) * 15);
  }

  let rarityScore = 65;
  if (maxHistoricalGap != null) {
    if (differencePctPoints >= maxHistoricalGap) {
      rarityScore = Math.min(100, 65 + (differencePctPoints - maxHistoricalGap) * 3);
    } else {
      rarityScore = Math.max(10, 40 - (maxHistoricalGap - differencePctPoints) * 2);
    }
  }

  const w = config.scoring;
  const raw =
    diffScore * w.weightDifference +
    liqScore * w.weightLiquidity +
    recencyScore * w.weightRecency +
    rarityScore * w.weightRarity;

  return Math.round(Math.min(100, Math.max(0, raw)));
}