from fastapi.testclient import TestClient

from prediction_market_engine.app import create_app
from prediction_market_engine.config import AppConfig


def test_signals_latest_endpoint(tmp_path):
    config = AppConfig(
        storage={"mode": "memory"},
        sources={"use_mock": True},
        service={"poll_interval_seconds": 3600},
    )
    app = create_app(config)
    with TestClient(app) as client:
        resp = client.get("/signals/latest")
        assert resp.status_code == 200
        data = resp.json()
        assert "signals" in data
        assert data["count"] >= 1
        signal = data["signals"][0]
        assert signal["type"] == "prediction_market_divergence"
        assert "market_a" in signal
        assert "market_b" in signal
        assert "tweet_hint" in signal


def test_opportunities_filters(tmp_path):
    config = AppConfig(
        storage={"mode": "memory"},
        sources={"use_mock": True},
        service={"poll_interval_seconds": 3600},
    )
    app = create_app(config)
    with TestClient(app) as client:
        resp = client.get("/opportunities", params={"min_score": 50, "topic": "Fed"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] >= 1


def test_health_endpoint(tmp_path):
    config = AppConfig(
        storage={"mode": "memory"},
        sources={"use_mock": True},
        service={"poll_interval_seconds": 3600},
    )
    app = create_app(config)
    with TestClient(app) as client:
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] in ("ok", "degraded")