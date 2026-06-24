from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from prediction_market_engine.config import AppConfig
from prediction_market_engine.models import CanonicalMarket, HealthStatus, utc_now
from prediction_market_engine.normalization.canonical_market import normalize_raw_market, to_observation
from prediction_market_engine.normalization.matcher import MarketMatcher
from prediction_market_engine.signals.divergence import DivergenceDetector
from prediction_market_engine.signals.repricing import RepricingDetector
from prediction_market_engine.signals.scoring import SignalScorer
from prediction_market_engine.sources.kalshi import KalshiSource
from prediction_market_engine.sources.polymarket import PolymarketSource
from prediction_market_engine.storage import Storage

logger = logging.getLogger(__name__)


@dataclass
class EngineState:
    last_poll_at: Optional[datetime] = None
    last_opportunities_found: int = 0
    last_markets_ingested: int = 0
    last_error: Optional[str] = None


class PredictionMarketEngine:
    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.storage = Storage(config.storage.db_path)
        self.kalshi = KalshiSource(config.sources.kalshi, use_mock=config.sources.use_mock)
        self.polymarket = PolymarketSource(config.sources.polymarket, use_mock=config.sources.use_mock)
        self.matcher = MarketMatcher()
        self.scorer = SignalScorer(config.scoring)
        self.divergence = DivergenceDetector(config.detection, self.scorer, self.storage)
        self.repricing = RepricingDetector(config.detection, self.storage)
        self.state = EngineState()

    def poll(self) -> int:
        """Ingest markets, detect signals, persist. Returns opportunity count."""
        logger.info("Starting poll cycle (mock=%s)", self.config.sources.use_mock)
        try:
            markets = self._ingest_all()
            self.state.last_markets_ingested = len(markets)

            pairs = self.matcher.match_cross_venue(markets)
            signals = self.divergence.detect_cross_venue(pairs)
            self.storage.upsert_signals(signals)

            repricing_alerts = self.repricing.detect(markets)
            if repricing_alerts:
                logger.info("Repricing alerts (not yet surfaced via API): %d", len(repricing_alerts))

            self.state.last_opportunities_found = len(signals)
            self.state.last_poll_at = utc_now()
            self.state.last_error = None
            logger.info(
                "Poll complete: %d markets, %d pairs, %d opportunities",
                len(markets),
                len(pairs),
                len(signals),
            )
            return len(signals)
        except Exception as exc:
            self.state.last_error = str(exc)
            logger.exception("Poll cycle failed: %s", exc)
            raise

    def _ingest_all(self) -> list[CanonicalMarket]:
        markets: list[CanonicalMarket] = []
        observations = []
        for source in (self.kalshi, self.polymarket):
            raw_list = source.fetch_markets()
            if not raw_list:
                logger.warning("%s returned no markets", source.name)
                continue
            for raw in raw_list:
                canonical = normalize_raw_market(raw)
                if canonical is None:
                    continue
                markets.append(canonical)
                observations.append(to_observation(canonical))
        if observations:
            self.storage.save_observations(observations)
        return markets

    def health(self) -> HealthStatus:
        sources = {
            "kalshi": "ok" if self.kalshi.is_healthy() else "error",
            "polymarket": "ok" if self.polymarket.is_healthy() else "error",
            "mode": "mock" if self.config.sources.use_mock else "live",
        }
        return HealthStatus(
            status="ok" if not self.state.last_error else "degraded",
            last_poll_at=self.state.last_poll_at,
            markets_tracked=self.state.last_markets_ingested,
            active_opportunities=self.storage.count_signals(active_only=True),
            signals_total=self.storage.count_signals(active_only=False),
            sources=sources,
        )