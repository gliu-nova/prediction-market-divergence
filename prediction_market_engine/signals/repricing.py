from __future__ import annotations

import logging

from prediction_market_engine.config import DetectionConfig
from prediction_market_engine.models import CanonicalMarket
from prediction_market_engine.storage import Storage

logger = logging.getLogger(__name__)


class RepricingDetector:
    """Detect sudden probability repricing vs recent history. MVP stub for future expansion."""

    def __init__(self, detection: DetectionConfig, storage: Storage) -> None:
        self.detection = detection
        self.storage = storage

    def detect(self, markets: list[CanonicalMarket]) -> list[dict]:
        alerts = []
        for m in markets:
            history = self.storage.get_historical_probabilities(
                m.canonical_id, m.venue.value, days=self.detection.lookback_days
            )
            if len(history) < 2:
                continue
            prev_prob = history[-2][1]
            change_pp = abs(m.probability - prev_prob) * 100.0
            if change_pp >= self.detection.repricing_threshold_pct_points:
                alerts.append(
                    {
                        "market_id": m.market_id,
                        "venue": m.venue.value,
                        "change_pct_points": change_pp,
                        "title": m.title,
                    }
                )
                logger.info("Repricing alert: %s %s (%.1f pp)", m.venue.value, m.market_id, change_pp)
        return alerts