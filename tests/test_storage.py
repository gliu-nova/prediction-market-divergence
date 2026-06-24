from datetime import datetime, timedelta, timezone

import pytest

from prediction_market_engine.config import AppConfig
from prediction_market_engine.engine import PredictionMarketEngine
from prediction_market_engine.models import MarketObservation, MarketSide, Signal, SignalType
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


def test_memory_mode_is_primary_store():
    storage = Storage(mode="memory")
    assert storage.uses_persistence is False
    assert storage._active_cache == {}
    obs = _obs("Kalshi", "K1", "fed-rates:test", 0.42, datetime.now(timezone.utc))
    storage.save_observation(obs)
    assert storage.count_observations() == 1
    assert storage.mode == "memory"


def test_sqlite_memory_persistent_connection():
    storage = Storage(db_path=":memory:", mode="sqlite")
    storage.save_observation(
        _obs("Kalshi", "K1", "fed-rates:test", 0.42, datetime.now(timezone.utc))
    )
    assert storage.count_observations() == 1
    storage2 = Storage(db_path=":memory:", mode="sqlite")
    # separate instance = new :memory: db (expected); same instance persists
    assert storage.count_observations() == 1


def test_max_historical_gap_aligns_offset_timestamps():
    storage = Storage(mode="memory")
    base = datetime(2026, 6, 24, 12, 0, 0, tzinfo=timezone.utc)
    poll_ts = base + timedelta(minutes=10)
    cid = "fed-rates:fed-cut-sep-2026"

    storage.save_observation(_obs("Kalshi", "K1", cid, 0.42, base))
    storage.save_observation(_obs("Polymarket", "P1", cid, 0.55, base + timedelta(seconds=90)))

    gap = storage.max_historical_gap(cid, "Kalshi", "Polymarket", days=30, exclude_since=poll_ts)
    assert gap == pytest.approx(13.0, abs=0.1)


def test_exclude_since_excludes_current_poll_observations():
    storage = Storage(mode="memory")
    poll_ts = datetime(2026, 6, 24, 12, 0, 0, tzinfo=timezone.utc)
    cid = "fed-rates:fed-cut-sep-2026"
    storage.save_observation(_obs("Kalshi", "K1", cid, 0.42, poll_ts))
    storage.save_observation(_obs("Polymarket", "P1", cid, 0.55, poll_ts))

    gap = storage.max_historical_gap(cid, "Kalshi", "Polymarket", exclude_since=poll_ts)
    assert gap is None


def test_observation_dedup_within_interval():
    storage = Storage(mode="memory")
    ts = datetime.now(timezone.utc)
    obs = _obs("Kalshi", "K1", "fed-rates:test", 0.42, ts)
    assert storage.save_observations([obs]) == 1
    assert storage.save_observations([obs], min_interval_seconds=300) == 0
    assert storage.count_observations() == 1


def test_stable_signal_id_no_duplicate_on_repoll(tmp_path):
    cfg = AppConfig(storage={"mode": "memory"}, sources={"use_mock": True})
    engine = PredictionMarketEngine(cfg)
    engine.poll()
    engine.poll()
    assert engine.storage.count_signals(active_only=True) == 1
    opps = engine.storage.get_opportunities(min_score=0)
    assert len(opps) == 1
    assert "2026_06_24" not in opps[0].id


def test_deactivate_stale_opportunities():
    storage = Storage(mode="memory")
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


def test_in_memory_cache_serves_opportunities():
    storage = Storage(mode="memory")
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


def test_sqlite_persistence_roundtrip(tmp_path):
    db = str(tmp_path / "persist.db")
    storage = Storage(db_path=db, mode="sqlite")
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

    reloaded = Storage(db_path=db, mode="sqlite")
    assert reloaded.get_signal_by_id(sig.id) is not None
    assert len(reloaded.get_opportunities(min_score=80)) == 1