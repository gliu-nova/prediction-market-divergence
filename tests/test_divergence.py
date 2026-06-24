from datetime import datetime, timezone

from prediction_market_engine.config import DetectionConfig, ScoringConfig
from prediction_market_engine.models import CanonicalMarket, Venue
from prediction_market_engine.normalization.matcher import MatchedPair
from prediction_market_engine.signals.divergence import DivergenceDetector
from prediction_market_engine.signals.scoring import SignalScorer


def _canonical(venue: Venue, prob: float, volume: float) -> CanonicalMarket:
    return CanonicalMarket(
        canonical_id="fed-rates:fed-cut-sep-2026",
        title="Fed cuts rates in September 2026",
        topic="Fed rates",
        venue=venue,
        market_id=f"{venue.value}-fed",
        probability=prob,
        volume=volume,
        liquidity=50000,
        url=f"https://{venue.value.lower()}.com/fed",
        observed_at=datetime.now(timezone.utc),
        match_key="fed-rates:fed-cut-sep-2026",
    )


def test_detects_fed_divergence(storage):
    pair = MatchedPair(
        match_key="fed-rates:fed-cut-sep-2026",
        topic="Fed rates",
        title="Fed cuts rates in September 2026",
        market_a=_canonical(Venue.KALSHI, 0.42, 125000),
        market_b=_canonical(Venue.POLYMARKET, 0.55, 340000),
    )
    detector = DivergenceDetector(
        DetectionConfig(min_divergence_pct_points=5.0, min_volume=1000.0),
        SignalScorer(ScoringConfig()),
        storage,
    )
    signals = detector.detect_cross_venue([pair], poll_ts=pair.market_a.observed_at)
    assert len(signals) == 1
    s = signals[0]
    assert s.difference_pct_points == 13.0
    assert s.market_a.venue == "Kalshi"
    assert s.market_b.venue == "Polymarket"
    assert s.score >= 50
    assert "disagree by 13 pts" in s.tweet_hint


def test_skips_small_divergence(storage):
    pair = MatchedPair(
        match_key="bitcoin:btc-100k",
        topic="Bitcoin",
        title="Bitcoin above $100k",
        market_a=_canonical(Venue.KALSHI, 0.38, 89000),
        market_b=_canonical(Venue.POLYMARKET, 0.41, 520000),
    )
    pair.market_a.topic = "Bitcoin"
    pair.market_b = _canonical(Venue.POLYMARKET, 0.41, 520000)
    pair.market_b.topic = "Bitcoin"
    pair.market_b.match_key = "bitcoin:btc-100k"
    detector = DivergenceDetector(
        DetectionConfig(min_divergence_pct_points=5.0),
        SignalScorer(ScoringConfig()),
        storage,
    )
    signals = detector.detect_cross_venue([pair], poll_ts=pair.market_a.observed_at)
    assert signals == []