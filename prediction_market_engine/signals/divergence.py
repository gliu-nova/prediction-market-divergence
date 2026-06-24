from __future__ import annotations

import logging
from datetime import datetime, timezone

from prediction_market_engine.config import DetectionConfig
from prediction_market_engine.models import MarketSide, Signal, SignalType, utc_now
from prediction_market_engine.normalization.matcher import MatchedPair
from prediction_market_engine.signals.scoring import SignalScorer
from prediction_market_engine.storage import Storage

logger = logging.getLogger(__name__)


class DivergenceDetector:
    def __init__(
        self,
        detection: DetectionConfig,
        scorer: SignalScorer,
        storage: Storage,
    ) -> None:
        self.detection = detection
        self.scorer = scorer
        self.storage = storage

    def detect_cross_venue(self, pairs: list[MatchedPair]) -> list[Signal]:
        signals: list[Signal] = []
        for pair in pairs:
            diff_pp = abs(pair.market_a.probability - pair.market_b.probability) * 100.0
            if diff_pp < self.detection.min_divergence_pct_points:
                continue

            vol_a = pair.market_a.volume or 0
            vol_b = pair.market_b.volume or 0
            if max(vol_a, vol_b) < self.detection.min_volume:
                logger.debug("Skipping %s: volume below minimum", pair.match_key)
                continue

            max_gap = self.storage.max_historical_gap(
                pair.match_key,
                pair.market_a.venue.value,
                pair.market_b.venue.value,
                days=self.detection.lookback_days,
            )
            lookback_context = self._lookback_context(diff_pp, max_gap)
            observed_at = max(pair.market_a.observed_at, pair.market_b.observed_at)
            score = self.scorer.score_divergence(
                diff_pp,
                pair.market_a,
                pair.market_b,
                max_historical_gap=max_gap,
                observed_at=observed_at,
            )

            signal_id = self._signal_id(pair)
            title = self._headline(pair.topic)
            tweet_hint = (
                f"{pair.market_a.venue.value} and {pair.market_b.venue.value} "
                f"disagree by {diff_pp:.0f} pts on {pair.topic.lower()} odds."
            )

            signal = Signal(
                id=signal_id,
                type=SignalType.PREDICTION_MARKET_DIVERGENCE,
                title=title,
                asset_or_topic=pair.topic,
                market_a=MarketSide(
                    venue=pair.market_a.venue.value,
                    probability=round(pair.market_a.probability, 4),
                    url=pair.market_a.url,
                    market_id=pair.market_a.market_id,
                    volume=pair.market_a.volume,
                    liquidity=pair.market_a.liquidity,
                ),
                market_b=MarketSide(
                    venue=pair.market_b.venue.value,
                    probability=round(pair.market_b.probability, 4),
                    url=pair.market_b.url,
                    market_id=pair.market_b.market_id,
                    volume=pair.market_b.volume,
                    liquidity=pair.market_b.liquidity,
                ),
                difference_pct_points=round(diff_pp, 1),
                implied_arb_profit_pct=round(diff_pp, 1),
                lookback_context=lookback_context,
                score=score,
                created_at=utc_now(),
                tweet_hint=tweet_hint,
                is_active=True,
            )
            signals.append(signal)
            logger.info(
                "Divergence detected: %s (%.1f pp, score=%d)",
                pair.match_key,
                diff_pp,
                score,
            )
        return signals

    def _lookback_context(self, diff_pp: float, max_gap: float | None) -> str:
        if max_gap is None:
            return "First cross-venue observation"
        if diff_pp > max_gap:
            return f"Largest gap in {self.detection.lookback_days} days"
        return f"Within {self.detection.lookback_days}-day range (max {max_gap:.1f} pp)"

    def _signal_id(self, pair: MatchedPair) -> str:
        date_str = datetime.now(timezone.utc).strftime("%Y_%m_%d")
        key_slug = pair.match_key.replace(":", "_").replace("-", "_")[:60]
        return f"kalshi_polymarket_{key_slug}_{date_str}"

    def _headline(self, topic: str) -> str:
        return f"{topic.upper()} ODDS DIVERGE"