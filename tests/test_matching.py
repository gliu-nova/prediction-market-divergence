from datetime import datetime, timezone

import pytest

from prediction_market_engine.models import CanonicalMarket, Venue
from prediction_market_engine.normalization.matcher import MarketMatcher


def _market(venue: Venue, match_key: str, prob: float) -> CanonicalMarket:
    return CanonicalMarket(
        canonical_id=match_key,
        title="Fed cuts rates in September 2026",
        topic="Fed rates",
        venue=venue,
        market_id=f"{venue.value}-1",
        probability=prob,
        volume=100000,
        url="https://example.com",
        observed_at=datetime.now(timezone.utc),
        match_key=match_key,
    )


def test_match_cross_venue_pairs():
    key = "fed-rates:fed-cuts-rates-september-2026-meeting"
    markets = [
        _market(Venue.KALSHI, key, 0.42),
        _market(Venue.POLYMARKET, key, 0.55),
        _market(Venue.KALSHI, "bitcoin:btc-100k", 0.38),
    ]
    pairs = MarketMatcher().match_cross_venue(markets)
    assert len(pairs) == 1
    assert pairs[0].market_a.venue != pairs[0].market_b.venue
    assert abs(pairs[0].market_a.probability - pairs[0].market_b.probability) == pytest.approx(0.13)


def test_no_match_single_venue():
    key = "macro:recession-2026"
    markets = [_market(Venue.KALSHI, key, 0.22)]
    assert MarketMatcher().match_cross_venue(markets) == []