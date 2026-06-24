from datetime import datetime, timezone

import pytest

from prediction_market_engine.config import ScoringConfig
from prediction_market_engine.models import CanonicalMarket, Venue
from prediction_market_engine.signals.scoring import SignalScorer


def _market(volume: float) -> CanonicalMarket:
    return CanonicalMarket(
        canonical_id="fed-rates:test",
        title="Test",
        topic="Fed rates",
        venue=Venue.KALSHI,
        market_id="T1",
        probability=0.42,
        volume=volume,
        url="https://example.com",
        observed_at=datetime.now(timezone.utc),
        match_key="fed-rates:test",
    )


def test_higher_difference_scores_higher():
    scorer = SignalScorer(ScoringConfig())
    a = _market(200000)
    b = _market(300000)
    low = scorer.score_divergence(5.0, a, b)
    high = scorer.score_divergence(15.0, a, b)
    assert high > low


def test_score_bounded_0_100():
    scorer = SignalScorer(ScoringConfig())
    score = scorer.score_divergence(25.0, _market(1_000_000), _market(1_000_000))
    assert 0 <= score <= 100


def test_fed_mock_divergence_scores_approximately_87():
    scorer = SignalScorer(ScoringConfig())
    kalshi = _market(125_000)
    kalshi.probability = 0.42
    poly = _market(340_000)
    poly.probability = 0.55
    score = scorer.score_divergence(
        13.0, kalshi, poly, max_historical_gap=None, observed_at=kalshi.observed_at
    )
    assert score == pytest.approx(87, abs=1)