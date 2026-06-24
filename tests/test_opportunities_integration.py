"""Integration tests driving real app + engine paths for /opportunities."""

from fastapi.testclient import TestClient

from prediction_market_engine.app import create_app
from prediction_market_engine.config import AppConfig
from prediction_market_engine.engine import PredictionMarketEngine


def _app_config(db_path: str) -> AppConfig:
    return AppConfig(
        storage={"db_path": db_path},
        sources={"use_mock": True},
        service={"poll_interval_seconds": 3600},
        detection={"min_divergence_pct_points": 5.0, "min_volume": 1000.0},
    )


def test_fed_divergence_surfaces_via_opportunities(tmp_path):
    cfg = _app_config(str(tmp_path / "fed.db"))
    engine = PredictionMarketEngine(cfg)
    count = engine.poll()
    assert count >= 1

    app = create_app(cfg)
    with TestClient(app) as client:
        resp = client.get("/opportunities", params={"min_score": 0, "topic": "Fed"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] >= 1

        opp = data["opportunities"][0]
        required = {
            "id",
            "title",
            "market_a",
            "market_b",
            "difference_pct_points",
            "score",
            "tweet_hint",
            "implied_arb_profit_pct",
            "lookback_context",
        }
        assert required.issubset(opp.keys())
        assert opp["difference_pct_points"] == 13.0
        assert opp["score"] >= 80
        assert "disagree by 13 pts" in opp["tweet_hint"]
        assert opp["market_a"]["venue"] in ("Kalshi", "Polymarket")
        assert opp["market_b"]["venue"] in ("Kalshi", "Polymarket")

        detail = client.get(f"/opportunities/{opp['id']}")
        assert detail.status_code == 200
        assert detail.json()["id"] == opp["id"]


def test_opportunities_filters_exclude_low_score(tmp_path):
    cfg = _app_config(str(tmp_path / "filter.db"))
    engine = PredictionMarketEngine(cfg)
    engine.poll()

    app = create_app(cfg)
    with TestClient(app) as client:
        all_resp = client.get("/opportunities", params={"min_score": 0})
        high_resp = client.get("/opportunities", params={"min_score": 99})
        assert all_resp.json()["count"] >= 1
        assert high_resp.json()["count"] == 0


def test_poll_survives_empty_source(monkeypatch, tmp_path):
    cfg = _app_config(str(tmp_path / "degraded.db"))

    from prediction_market_engine.sources import kalshi

    def _empty_fetch(self):
        return []

    monkeypatch.setattr(kalshi.KalshiSource, "fetch_markets", _empty_fetch)

    engine = PredictionMarketEngine(cfg)
    count = engine.poll()
    assert count == 0
    assert engine.state.last_error is None