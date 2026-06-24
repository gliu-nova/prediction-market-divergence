from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI

from prediction_market_engine.api.routes import create_router
from prediction_market_engine.config import AppConfig, load_config
from prediction_market_engine.engine import PredictionMarketEngine

logger = logging.getLogger(__name__)


def create_app(config: AppConfig | None = None) -> FastAPI:
    cfg = config or load_config()
    engine = PredictionMarketEngine(cfg)
    scheduler = BackgroundScheduler()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        )
        try:
            engine.poll()
        except Exception:
            logger.warning("Initial poll failed; service will retry on schedule")

        interval = cfg.service.poll_interval_seconds
        scheduler.add_job(engine.poll, "interval", seconds=interval, id="poll")
        scheduler.start()
        logger.info("Scheduler started (every %ds)", interval)
        yield
        scheduler.shutdown(wait=False)

    app = FastAPI(
        title="Prediction Market Divergence",
        description="Cross-venue prediction market signal engine for twitter-bot",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.include_router(create_router(engine))
    app.state.engine = engine
    return app