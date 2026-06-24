from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field


class ServiceConfig(BaseModel):
    host: str = "0.0.0.0"
    port: int = 8080
    poll_interval_seconds: int = 300


class StorageConfig(BaseModel):
    db_path: str = "data/prediction_markets.db"
    opportunity_max_age_hours: int = 24
    observation_retention_days: int = 30


class KalshiSourceConfig(BaseModel):
    enabled: bool = True
    base_url: str = "https://api.elections.kalshi.com/trade-api/v2"


class PolymarketSourceConfig(BaseModel):
    enabled: bool = True
    base_url: str = "https://gamma-api.polymarket.com"


class SourcesConfig(BaseModel):
    use_mock: bool = True
    kalshi: KalshiSourceConfig = Field(default_factory=KalshiSourceConfig)
    polymarket: PolymarketSourceConfig = Field(default_factory=PolymarketSourceConfig)


class DetectionConfig(BaseModel):
    min_divergence_pct_points: float = 5.0
    min_volume: float = 1000.0
    repricing_threshold_pct_points: float = 8.0
    lookback_days: int = 30


class ScoringConfig(BaseModel):
    weight_difference: float = 0.40
    weight_liquidity: float = 0.25
    weight_recency: float = 0.20
    weight_rarity: float = 0.15


class AppConfig(BaseModel):
    service: ServiceConfig = Field(default_factory=ServiceConfig)
    storage: StorageConfig = Field(default_factory=StorageConfig)
    sources: SourcesConfig = Field(default_factory=SourcesConfig)
    detection: DetectionConfig = Field(default_factory=DetectionConfig)
    scoring: ScoringConfig = Field(default_factory=ScoringConfig)


def _apply_env_overrides(config: AppConfig) -> AppConfig:
    if host := os.getenv("PMD_HOST"):
        config.service.host = host
    if port := os.getenv("PMD_PORT"):
        config.service.port = int(port)
    if poll := os.getenv("PMD_POLL_INTERVAL_SECONDS"):
        config.service.poll_interval_seconds = int(poll)
    if use_mock := os.getenv("PMD_USE_MOCK"):
        config.sources.use_mock = use_mock.lower() in ("1", "true", "yes")
    if min_div := os.getenv("PMD_MIN_DIVERGENCE_PCT_POINTS"):
        config.detection.min_divergence_pct_points = float(min_div)
    if min_vol := os.getenv("PMD_MIN_VOLUME"):
        config.detection.min_volume = float(min_vol)
    if max_age := os.getenv("PMD_OPPORTUNITY_MAX_AGE_HOURS"):
        config.storage.opportunity_max_age_hours = int(max_age)
    return config


def load_config(path: str | Path | None = None) -> AppConfig:
    root = Path(__file__).resolve().parent.parent
    config_path = Path(path) if path else root / "config.yaml"
    data: dict[str, Any] = {}
    if config_path.exists():
        with config_path.open() as f:
            data = yaml.safe_load(f) or {}
    config = AppConfig.model_validate(data)
    return _apply_env_overrides(config)