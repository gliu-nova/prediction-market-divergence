from __future__ import annotations

import math
from datetime import datetime, timezone

from prediction_market_engine.config import ScoringConfig
from prediction_market_engine.models import CanonicalMarket


class SignalScorer:
    def __init__(self, config: ScoringConfig) -> None:
        self.config = config

    def score_divergence(
        self,
        difference_pct_points: float,
        market_a: CanonicalMarket,
        market_b: CanonicalMarket,
        max_historical_gap: float | None = None,
        observed_at: datetime | None = None,
    ) -> int:
        # 15pp gap = full magnitude score (explainable reference for traders)
        diff_score = min(100.0, (difference_pct_points / 15.0) * 100.0)

        vol_a = market_a.volume or 0
        vol_b = market_b.volume or 0
        liquidity = max(vol_a, vol_b)
        liq_score = min(100.0, (math.log10(liquidity + 1) / 6.0) * 100.0) if liquidity > 0 else 20.0

        ts = observed_at or market_a.observed_at
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        age_minutes = (datetime.now(timezone.utc) - ts).total_seconds() / 60.0
        recency_score = max(0.0, 100.0 - age_minutes * 2.0)

        if max_historical_gap is not None and difference_pct_points > max_historical_gap:
            rarity_score = min(100.0, 60.0 + (difference_pct_points - max_historical_gap) * 3.0)
        elif max_historical_gap is None:
            rarity_score = 65.0  # first cross-venue observation — novel baseline
        else:
            rarity_score = max(10.0, 40.0 - (max_historical_gap - difference_pct_points) * 2.0)

        w = self.config
        raw = (
            diff_score * w.weight_difference
            + liq_score * w.weight_liquidity
            + recency_score * w.weight_recency
            + rarity_score * w.weight_rarity
        )
        return int(round(min(100.0, max(0.0, raw))))