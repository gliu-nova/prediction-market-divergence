from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from prediction_market_engine.engine import PredictionMarketEngine
from prediction_market_engine.models import Opportunity, Signal


def create_router(engine: PredictionMarketEngine) -> APIRouter:
    router = APIRouter()

    @router.get("/health")
    def health():
        return engine.health().model_dump(mode="json")

    @router.get("/status")
    def status():
        return engine.health().model_dump(mode="json")

    @router.post("/poll")
    def trigger_poll():
        count = engine.poll()
        return {"opportunities_found": count, "status": "ok"}

    @router.get("/signals/latest")
    def signals_latest(limit: int = Query(default=10, ge=1, le=100)):
        signals = engine.storage.get_signals(min_score=0, limit=limit, active_only=True)
        return {"signals": [s.model_dump(mode="json") for s in signals], "count": len(signals)}

    @router.get("/signals")
    def signals_filtered(
        min_score: int = Query(default=0, ge=0, le=100),
        limit: int = Query(default=50, ge=1, le=200),
    ):
        signals = engine.storage.get_signals(min_score=min_score, limit=limit)
        return {"signals": [s.model_dump(mode="json") for s in signals], "count": len(signals)}

    @router.get("/signals/{signal_id}")
    def signal_detail(signal_id: str):
        signal = engine.storage.get_signal_by_id(signal_id)
        if not signal:
            raise HTTPException(status_code=404, detail="Signal not found")
        return signal.model_dump(mode="json")

    @router.get("/opportunities")
    def opportunities(
        min_score: int = Query(default=0, ge=0, le=100),
        min_difference_pct_points: float = Query(default=0.0, ge=0.0),
        min_volume: float = Query(default=0.0, ge=0.0),
        venue: Optional[str] = Query(default=None),
        topic: Optional[str] = Query(default=None),
        limit: int = Query(default=50, ge=1, le=200),
    ):
        opps = engine.storage.get_opportunities(
            min_score=min_score,
            min_difference_pct_points=min_difference_pct_points,
            min_volume=min_volume,
            venue=venue,
            topic=topic,
            limit=limit,
        )
        return {
            "opportunities": [_opportunity_payload(o) for o in opps],
            "count": len(opps),
        }

    @router.get("/opportunities/{opportunity_id}")
    def opportunity_detail(opportunity_id: str):
        signal = engine.storage.get_signal_by_id(opportunity_id)
        if not signal:
            raise HTTPException(status_code=404, detail="Opportunity not found")
        opp = Opportunity(**signal.model_dump(), detected_at=signal.created_at)
        return _opportunity_payload(opp)

    @router.get("/markets")
    def markets_summary():
        health = engine.health()
        return {
            "markets_tracked": health.markets_tracked,
            "last_poll_at": health.last_poll_at,
            "active_opportunities": health.active_opportunities,
            "sources": health.sources,
        }

    return router


def _opportunity_payload(opp: Opportunity) -> dict:
    data = opp.model_dump(mode="json")
    data["detected_at"] = opp.detected_at.isoformat()
    return data