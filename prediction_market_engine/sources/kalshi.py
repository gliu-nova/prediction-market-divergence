from __future__ import annotations

import logging
from typing import Any

import httpx

from prediction_market_engine.config import KalshiSourceConfig
from prediction_market_engine.sources.base import MarketSource
from prediction_market_engine.sources.mock import MockSource

logger = logging.getLogger(__name__)


class KalshiSource(MarketSource):
    name = "kalshi"

    def __init__(self, config: KalshiSourceConfig, use_mock: bool = False) -> None:
        self.config = config
        self.use_mock = use_mock
        self._mock = MockSource("kalshi")

    def fetch_markets(self) -> list[dict[str, Any]]:
        if self.use_mock or not self.config.enabled:
            return self._mock.fetch_markets()
        try:
            with httpx.Client(timeout=15.0) as client:
                resp = client.get(
                    f"{self.config.base_url}/markets",
                    params={"limit": 100, "status": "open"},
                )
                resp.raise_for_status()
                data = resp.json()
            markets = data.get("markets", data) if isinstance(data, dict) else data
            if not isinstance(markets, list):
                logger.error("Kalshi returned unexpected payload shape")
                return []
            return [dict(m, venue="kalshi") for m in markets]
        except (httpx.HTTPError, ValueError) as exc:
            logger.error("Kalshi fetch failed: %s", exc)
            return []

    def is_healthy(self) -> bool:
        if self.use_mock:
            return True
        try:
            with httpx.Client(timeout=5.0) as client:
                resp = client.get(f"{self.config.base_url}/markets", params={"limit": 1})
                return resp.status_code == 200
        except httpx.HTTPError:
            return False