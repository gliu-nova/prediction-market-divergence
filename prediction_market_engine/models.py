from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class Venue(str, Enum):
    KALSHI = "Kalshi"
    POLYMARKET = "Polymarket"


class SignalType(str, Enum):
    PREDICTION_MARKET_DIVERGENCE = "prediction_market_divergence"
    SUDDEN_REPRICING = "sudden_repricing"
    PROBABILITY_SUM_INEFFICIENCY = "probability_sum_inefficiency"


class MarketSide(BaseModel):
    venue: str
    probability: float = Field(ge=0.0, le=1.0)
    url: str
    market_id: str
    volume: Optional[float] = None
    liquidity: Optional[float] = None


class CanonicalMarket(BaseModel):
    """Normalized market representation across venues."""

    canonical_id: str
    title: str
    topic: str
    venue: Venue
    market_id: str
    probability: float = Field(ge=0.0, le=1.0)
    volume: Optional[float] = None
    liquidity: Optional[float] = None
    url: str
    observed_at: datetime
    match_key: str


class MarketObservation(BaseModel):
    """Raw observation stored for history."""

    id: Optional[int] = None
    venue: str
    market_id: str
    canonical_id: str
    title: str
    topic: str
    probability: float
    volume: Optional[float] = None
    liquidity: Optional[float] = None
    url: str
    observed_at: datetime


class Signal(BaseModel):
    id: str
    type: SignalType
    title: str
    asset_or_topic: str
    market_a: MarketSide
    market_b: Optional[MarketSide] = None
    difference_pct_points: Optional[float] = None
    implied_arb_profit_pct: Optional[float] = None
    lookback_context: Optional[str] = None
    score: int = Field(ge=0, le=100)
    created_at: datetime
    tweet_hint: str
    is_active: bool = True


class Opportunity(Signal):
    """Active divergence opportunity with extra filter fields."""

    min_volume: Optional[float] = None
    detected_at: datetime


class HealthStatus(BaseModel):
    status: str
    last_poll_at: Optional[datetime] = None
    markets_tracked: int = 0
    active_opportunities: int = 0
    signals_total: int = 0
    sources: dict[str, str] = Field(default_factory=dict)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)