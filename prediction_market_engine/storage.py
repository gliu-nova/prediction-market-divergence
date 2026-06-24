from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from prediction_market_engine.models import MarketObservation, Opportunity, Signal

logger = logging.getLogger(__name__)

_ALIGNMENT_TOLERANCE = timedelta(minutes=5)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venue TEXT NOT NULL,
    market_id TEXT NOT NULL,
    canonical_id TEXT NOT NULL,
    title TEXT NOT NULL,
    topic TEXT NOT NULL,
    probability REAL NOT NULL,
    volume REAL,
    liquidity REAL,
    url TEXT NOT NULL,
    observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_canonical ON observations(canonical_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_obs_venue ON observations(venue, market_id);

CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    score INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_score ON signals(score DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_active ON signals(is_active, score DESC);
"""


def _parse_ts(value: str) -> datetime:
    ts = datetime.fromisoformat(value)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts


class Storage:
    """SQLite persistence plus in-memory cache of active opportunities for fast API reads."""

    def __init__(
        self,
        db_path: str,
        opportunity_max_age_hours: int = 24,
        observation_retention_days: int = 30,
    ) -> None:
        self.db_path = db_path
        self.opportunity_max_age_hours = opportunity_max_age_hours
        self.observation_retention_days = observation_retention_days
        self._active_cache: dict[str, Signal] = {}
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self._load_active_cache()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    def _load_active_cache(self) -> None:
        """Hydrate in-memory cache from DB on startup."""
        cutoff = (
            datetime.now(timezone.utc) - timedelta(hours=self.opportunity_max_age_hours)
        ).isoformat()
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT payload FROM signals
                WHERE is_active = 1 AND created_at >= ?
                ORDER BY score DESC
                """,
                (cutoff,),
            ).fetchall()
        self._active_cache = {
            Signal.model_validate(json.loads(row["payload"])).id: Signal.model_validate(
                json.loads(row["payload"])
            )
            for row in rows
        }

    def save_observation(self, obs: MarketObservation) -> int:
        with self._connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO observations
                (venue, market_id, canonical_id, title, topic, probability,
                 volume, liquidity, url, observed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    obs.venue,
                    obs.market_id,
                    obs.canonical_id,
                    obs.title,
                    obs.topic,
                    obs.probability,
                    obs.volume,
                    obs.liquidity,
                    obs.url,
                    obs.observed_at.isoformat(),
                ),
            )
            return int(cur.lastrowid)

    def _should_save_observation(
        self,
        obs: MarketObservation,
        min_interval_seconds: int = 60,
    ) -> bool:
        """Skip duplicate snapshots within the poll interval."""
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT observed_at, probability FROM observations
                WHERE venue = ? AND market_id = ?
                ORDER BY observed_at DESC LIMIT 1
                """,
                (obs.venue, obs.market_id),
            ).fetchone()
        if not row:
            return True
        last_ts = _parse_ts(row["observed_at"])
        age = (obs.observed_at - last_ts).total_seconds()
        if age < min_interval_seconds and abs(row["probability"] - obs.probability) < 0.001:
            return False
        return True

    def save_observations(
        self,
        observations: list[MarketObservation],
        min_interval_seconds: int = 60,
    ) -> int:
        count = 0
        for obs in observations:
            if self._should_save_observation(obs, min_interval_seconds):
                self.save_observation(obs)
                count += 1
        return count

    def prune_observations(self, retention_days: int | None = None) -> int:
        days = retention_days or self.observation_retention_days
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM observations WHERE observed_at < ?", (cutoff,)
            )
            deleted = cur.rowcount
        if deleted:
            logger.info("Pruned %d observations older than %d days", deleted, days)
        return deleted

    def get_historical_probabilities(
        self,
        canonical_id: str,
        venue: str,
        days: int = 30,
    ) -> list[tuple[datetime, float]]:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT observed_at, probability FROM observations
                WHERE canonical_id = ? AND venue = ? AND observed_at >= ?
                ORDER BY observed_at ASC
                """,
                (canonical_id, venue, cutoff),
            ).fetchall()
        return [(_parse_ts(row["observed_at"]), row["probability"]) for row in rows]

    def max_historical_gap(
        self,
        canonical_id: str,
        venue_a: str,
        venue_b: str,
        days: int = 30,
        exclude_since: Optional[datetime] = None,
    ) -> Optional[float]:
        """Find max cross-venue gap using nearest timestamp alignment within tolerance.

        exclude_since: omit observations from the current poll so lookback reflects prior history.
        """
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        exclude_iso = exclude_since.isoformat() if exclude_since else None
        with self._connect() as conn:
            if exclude_iso:
                rows_a = conn.execute(
                    """
                    SELECT observed_at, probability FROM observations
                    WHERE canonical_id = ? AND venue = ? AND observed_at >= ?
                      AND observed_at < ?
                    ORDER BY observed_at ASC
                    """,
                    (canonical_id, venue_a, cutoff, exclude_iso),
                ).fetchall()
                rows_b = conn.execute(
                    """
                    SELECT observed_at, probability FROM observations
                    WHERE canonical_id = ? AND venue = ? AND observed_at >= ?
                      AND observed_at < ?
                    ORDER BY observed_at ASC
                    """,
                    (canonical_id, venue_b, cutoff, exclude_iso),
                ).fetchall()
            else:
                rows_a = conn.execute(
                    """
                    SELECT observed_at, probability FROM observations
                    WHERE canonical_id = ? AND venue = ? AND observed_at >= ?
                    ORDER BY observed_at ASC
                    """,
                    (canonical_id, venue_a, cutoff),
                ).fetchall()
                rows_b = conn.execute(
                    """
                    SELECT observed_at, probability FROM observations
                    WHERE canonical_id = ? AND venue = ? AND observed_at >= ?
                    ORDER BY observed_at ASC
                    """,
                    (canonical_id, venue_b, cutoff),
                ).fetchall()
        if not rows_a or not rows_b:
            return None

        series_a = [(_parse_ts(r["observed_at"]), r["probability"]) for r in rows_a]
        series_b = [(_parse_ts(r["observed_at"]), r["probability"]) for r in rows_b]

        gaps: list[float] = []
        for ts_b, prob_b in series_b:
            best_delta = None
            best_prob_a = None
            for ts_a, prob_a in series_a:
                delta = abs((ts_a - ts_b).total_seconds())
                if delta <= _ALIGNMENT_TOLERANCE.total_seconds():
                    if best_delta is None or delta < best_delta:
                        best_delta = delta
                        best_prob_a = prob_a
            if best_prob_a is not None:
                gaps.append(abs(best_prob_a - prob_b) * 100.0)

        return max(gaps) if gaps else None

    def upsert_signal(self, signal: Signal) -> None:
        payload = signal.model_dump(mode="json")
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO signals (id, type, payload, score, is_active, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    payload = excluded.payload,
                    score = excluded.score,
                    is_active = excluded.is_active,
                    created_at = excluded.created_at
                """,
                (
                    signal.id,
                    signal.type.value,
                    json.dumps(payload),
                    signal.score,
                    1 if signal.is_active else 0,
                    signal.created_at.isoformat(),
                ),
            )

    def sync_active_opportunities(self, signals: list[Signal]) -> int:
        """Persist current poll signals, update in-memory cache, deactivate stale ones."""
        active_ids = {s.id for s in signals}
        for signal in signals:
            signal.is_active = True
            self.upsert_signal(signal)
            self._active_cache[signal.id] = signal

        self.deactivate_signals_except(active_ids)
        self._prune_stale_cache()
        return len(signals)

    def deactivate_signals_except(self, keep_ids: set[str]) -> int:
        stale_ids = [sid for sid in self._active_cache if sid not in keep_ids]
        if not stale_ids:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id FROM signals WHERE is_active = 1"
                ).fetchall()
                stale_ids = [r["id"] for r in rows if r["id"] not in keep_ids]

        if not stale_ids:
            return 0

        with self._connect() as conn:
            placeholders = ",".join("?" * len(stale_ids))
            conn.execute(
                f"UPDATE signals SET is_active = 0 WHERE id IN ({placeholders})",
                stale_ids,
            )
        for sid in stale_ids:
            self._active_cache.pop(sid, None)
        logger.info("Deactivated %d stale opportunities", len(stale_ids))
        return len(stale_ids)

    def _prune_stale_cache(self) -> None:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=self.opportunity_max_age_hours)
        expired_ids = []
        for sid, sig in self._active_cache.items():
            ts = sig.created_at
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if ts < cutoff:
                expired_ids.append(sid)
        for sid in expired_ids:
            self._active_cache.pop(sid, None)

    def upsert_signals(self, signals: list[Signal]) -> int:
        return self.sync_active_opportunities(signals)

    def get_signals(
        self,
        min_score: int = 0,
        limit: int = 50,
        active_only: bool = False,
    ) -> list[Signal]:
        if active_only:
            return self._filter_cached_signals(min_score=min_score, limit=limit)

        query = "SELECT payload FROM signals WHERE score >= ?"
        params: list = [min_score]
        query += " ORDER BY score DESC, created_at DESC LIMIT ?"
        params.append(limit)
        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [Signal.model_validate(json.loads(row["payload"])) for row in rows]

    def get_signal_by_id(self, signal_id: str) -> Optional[Signal]:
        if signal_id in self._active_cache:
            return self._active_cache[signal_id]
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM signals WHERE id = ?", (signal_id,)
            ).fetchone()
        if not row:
            return None
        return Signal.model_validate(json.loads(row["payload"]))

    def _filter_cached_signals(
        self,
        min_score: int = 0,
        min_difference_pct_points: float = 0.0,
        min_volume: float = 0.0,
        venue: Optional[str] = None,
        topic: Optional[str] = None,
        limit: int = 50,
    ) -> list[Signal]:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=self.opportunity_max_age_hours)
        candidates = sorted(
            self._active_cache.values(),
            key=lambda s: (s.score, s.created_at),
            reverse=True,
        )
        results: list[Signal] = []
        for s in candidates:
            ts = s.created_at
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if ts < cutoff:
                continue
            if s.score < min_score:
                continue
            if s.type.value != "prediction_market_divergence":
                continue
            if s.difference_pct_points is None or s.difference_pct_points < min_difference_pct_points:
                continue
            vol_a = s.market_a.volume or 0
            vol_b = (s.market_b.volume or 0) if s.market_b else 0
            if max(vol_a, vol_b) < min_volume:
                continue
            if venue and venue.lower() not in (
                s.market_a.venue.lower(),
                (s.market_b.venue.lower() if s.market_b else ""),
            ):
                continue
            if topic and topic.lower() not in s.asset_or_topic.lower():
                continue
            results.append(s)
            if len(results) >= limit:
                break
        return results

    def get_opportunities(
        self,
        min_score: int = 0,
        min_difference_pct_points: float = 0.0,
        min_volume: float = 0.0,
        venue: Optional[str] = None,
        topic: Optional[str] = None,
        limit: int = 50,
    ) -> list[Opportunity]:
        signals = self._filter_cached_signals(
            min_score=min_score,
            min_difference_pct_points=min_difference_pct_points,
            min_volume=min_volume,
            venue=venue,
            topic=topic,
            limit=limit,
        )
        return [
            Opportunity(
                **s.model_dump(),
                detected_at=s.created_at,
                min_volume=min(
                    s.market_a.volume or 0,
                    (s.market_b.volume or 0) if s.market_b else 0,
                )
                or max(s.market_a.volume or 0, (s.market_b.volume or 0) if s.market_b else 0),
            )
            for s in signals
        ]

    def count_observations(self) -> int:
        with self._connect() as conn:
            row = conn.execute("SELECT COUNT(*) AS c FROM observations").fetchone()
        return int(row["c"])

    def count_signals(self, active_only: bool = False) -> int:
        if active_only:
            return len(self._active_cache)
        with self._connect() as conn:
            row = conn.execute("SELECT COUNT(*) AS c FROM signals").fetchone()
        return int(row["c"])

    def latest_observation_time(self) -> Optional[datetime]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT MAX(observed_at) AS ts FROM observations"
            ).fetchone()
        if not row or not row["ts"]:
            return None
        return _parse_ts(row["ts"])