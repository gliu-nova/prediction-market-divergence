from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from prediction_market_engine.models import CanonicalMarket


class MarketSource(ABC):
    name: str

    @abstractmethod
    def fetch_markets(self) -> list[dict[str, Any]]:
        """Fetch raw market payloads from the venue API."""

    @abstractmethod
    def is_healthy(self) -> bool:
        """Return True if the source is reachable."""