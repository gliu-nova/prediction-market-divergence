from datetime import datetime, timedelta, timezone

import pytest

from prediction_market_engine.models import MarketObservation, Signal, SignalType, MarketSide
from prediction_market_engine.storage import Storage


def _obs(
    venue: str,
    market_id: str,
    canonical_id: str,
    prob: float,
    ts: datetime,
) -> MarketObservation:
    return MarketObservation(
        venue=venue,
        market_id=market_id,
        canonical_id=canonical_id,
        title="Fed cut",
        topic="Fed rates",
        probability=prob,
        volume=100000,
        url="https://example.com",
        observed_at=ts,
    )


def test_max_historical_gap_aligns_offset_timestamps(tmp_path):
    storage = Storage(str(tmp_path / "gap.db"))
    base = datetime(2026, 6, 24, 12, 0, 0, tzinfo=timezone.utc)
    cid = "fed-rates:fed-cut-sep-2026"

    storage.save_observation(_obs("Kalshi", "K1", cid, 0.42, base))
    storage.save_observation(_obs("Polymarket", "P1", cid, 0.55, base + timedelta(seconds=90)))

    gap = storage.max_historical_gap(cid, "Kalshi", "Polymarket", days=30)
    assert gap is not None
    assert gap == pytest.approx(13.0, abs=0.1)


def test_observation_dedup_within_interval(tmp_path):
    storage = Storage(str(tmp_path / "dedup.db"))
    ts = datetime.now(timezone.utc)
    obs = _obs("Kalshi", "K1", "fed-rates:test", 0.42, ts)
    assert storage.save_observations([obs]) == 1
    assert storage.save_observations([obs], min_interval_seconds=300) == 0
    assert storage.count_observations() == 1


def test_stable_signal_id_no_duplicate_on_repoll(tmp_path):
    from prediction_market_engine.config import AppConfig
    from prediction_market_engine.engine import PredictionMarketEngine

    cfg = AppConfig(
        storage={"db_path": str(tmp_path / "repoll.db")},
        sources={"use_mock": True},
    )
    engine = PredictionMarketEngine(cfg)
    engine.poll()
    engine.poll()
    assert engine.storage.count_signals(active_only=True) == 1
    opps = engine.storage.get_opportunities(min_score=0)
    assert len(opps) == 1
    assert "2026_06_24" not in opps[0].id


def test_deactivate_stale_opportunities(tmp_path):
    storage = Storage(str(tmp_path / "stale.db"))
    old = Signal(
        id="kalshi_polymarket_old_market",
        type=SignalType.PREDICTION_MARKET_DIVERGENCE,
        title="OLD",
        asset_or_topic="Macro",
        market_a=MarketSide(venue="Kalshi", probability=0.5, url="u", market_id="k"),
        market_b=MarketSide(venue="Polymarket", probability=0.6, url="u", market_id="p"),
        difference_pct_points=10.0,
        score=80,
        created_at=datetime.now(timezone.utc),
        tweet_hint="old",
        is_active=True,
    )
    storage.sync_active_opportunities([old])

    new = Signal(
        id="kalshi_polymarket_fed_rates_fed_cut_sep_2026",
        type=SignalType.PREDICTION_MARKET_DIVERGENCE,
        title="NEW",
        asset_or_topic="Fed rates",
        market_a=MarketSide(venue="Kalshi", probability=0.42, url="u", market_id="k"),
        market_b=MarketSide(venue="Polymarket", probability=0.55, url="u", market_id="p"),
        difference_pct_points=13.0,
        score=87,
        created_at=datetime.now(timezone.utc),
        tweet_hint="new",
        is_active=True,
    )
    storage.sync_active_opportunities([new])

    active = storage.get_opportunities(min_score=0)
    assert len(active) == 1
    assert active[0].id == new.id


def test_in_memory_cache_serves_opportunities(tmp_path):
    storage = Storage(str(tmp_path / "cache.db"))
    assert storage._active_cache == {}
    sig = Signal(
        id="kalshi_polymarket_test",
        type=SignalType.PREDICTION_MARKET_DIVERGENCE,
        title="TEST",
        asset_or_topic="Fed rates",
        market_a=MarketSide(venue="Kalshi", probability=0.42, url="u", market_id="k", volume=5000),
        market_b=MarketSide(venue="Polymarket", probability=0.55, url="u", market_id="p", volume=5000),
        difference_pct_points=13.0,
        score=87,
        created_at=datetime.now(timezone.utc),
        tweet_hint="hint",
        is_active=True,
    )
    storage.sync_active_opportunities([sig])
    assert len(storage._active_cache) == 1
    opps = storage.get_opportunities(min_score=80)
    assert len(opps) == 1
    assert opps[0].tweet_hint == "hint"

