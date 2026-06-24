import os

from prediction_market_engine.config import AppConfig, _apply_env_overrides


def test_env_overrides_poll_and_detection(monkeypatch):
    monkeypatch.setenv("PMD_POLL_INTERVAL_SECONDS", "120")
    monkeypatch.setenv("PMD_MIN_DIVERGENCE_PCT_POINTS", "8.5")
    monkeypatch.setenv("PMD_MIN_VOLUME", "5000")
    monkeypatch.setenv("PMD_USE_MOCK", "true")

    config = _apply_env_overrides(AppConfig())
    assert config.service.poll_interval_seconds == 120
    assert config.detection.min_divergence_pct_points == 8.5
    assert config.detection.min_volume == 5000.0
    assert config.sources.use_mock is True


def test_env_storage_mode_and_db_path(monkeypatch):
    monkeypatch.setenv("PMD_STORAGE_MODE", "sqlite")
    monkeypatch.setenv("PMD_DB_PATH", "/tmp/pmd_test.db")
    config = _apply_env_overrides(AppConfig())
    assert config.storage.mode == "sqlite"
    assert config.storage.db_path == "/tmp/pmd_test.db"


def test_env_override_host_port(monkeypatch):
    monkeypatch.setenv("PMD_HOST", "127.0.0.1")
    monkeypatch.setenv("PMD_PORT", "9090")
    config = _apply_env_overrides(AppConfig())
    assert config.service.host == "127.0.0.1"
    assert config.service.port == 9090