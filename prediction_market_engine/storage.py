from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal, Optional

from prediction_market_engine.models import MarketObservation, Opportunity, Signal

logger = logging.getLogger(__name__)

StorageMode = Literal["memory", "sqlite"]
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


def _parse_ts(value: str | datetime) -> datetime:
    if isinstance(value, datetime):
        ts = value
    else:
        ts = datetime.fromisoformat(value)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts


def _ts_before(observed_at: datetime, exclude_since: datetime) -> bool:
    """True if observation is strictly before the current poll window."""
    obs = _parse_ts(observed_at)
    excl = _parse_ts(exclude_since)
    return obs < excl


class Storage:
    """In-memory primary store for opportunities; optional SQLite persistence."""

    def __init__(
        self,
        db_path: str = ":memory:",
        mode: StorageMode = "memory",
        opportunity_max_age_hours: int = 24,
        observation_retention_days: int = 30,
        inactive_signal_retention_days: int = 7,
    ) -> None:
        self.db_path = db_path
        self.mode: StorageMode = mode
        self.opportunity_max_age_hours = opportunity_max_age_hours
        self.observation_retention_days = observation_retention_days
        self.inactive_signal_retention_days = inactive_signal_retention_days

        # Primary in-memory stores (source of truth for API reads)
        self._active_cache: dict[str, Signal] = {}
        self._observations: list[MarketObservation] = []

        self._conn: sqlite3.Connection | None = None
        if self.mode == "sqlite":
            if self.db_path != ":memory:":
                Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
            self._init_sqlite()
            self._hydrate_from_sqlite()

    @property
    def uses_persistence(self) -> bool:
        return self.mode == "sqlite"

    def _init_sqlite(self) -> None:
        conn = self._get_sqlite_conn()
        conn.executescript(_SCHEMA)
        conn.commit()

    def _get_sqlite_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
            self._conn.row_factory = sqlite3.Row
        return self._conn

    def _hydrate_from_sqlite(self) -> None:
        cutoff = (
            datetime.now(timezone.utc) - timedelta(hours=self.opportunity_max_age_hours)
        ).isoformat()
        conn = self._get_sqlite_conn()
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

        obs_rows = conn.execute(
            """
            SELECT venue, market_id, canonical_id, title, topic, probability,
                   volume, liquidity, url, observed_at
            FROM observations
            ORDER BY observed_at ASC
            """
        ).fetchall()
        self._observations = [
            MarketObservation(
                venue=r["venue"],
                market_id=r["market_id"],
                canonical_id=r["canonical_id"],
                title=r["title"],
                topic=r["topic"],
                probability=r["probability"],
                volume=r["volume"],
                liquidity=r["liquidity"],
                url=r["url"],
                observed_at=_parse_ts(r["observed_at"]),
            )
            for r in obs_rows
        ]

    def save_observation(self, obs: MarketObservation) -> int:
        self._observations.append(obs)
        if self.mode == "sqlite":
            conn = self._get_sqlite_conn()
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
            conn.commit()
            return int(cur.lastrowid)
        return len(self._observations)

    def _should_save_observation(
        self,
        obs: MarketObservation,
        min_interval_seconds: int = 60,
    ) -> bool:
        prior = [
            o
            for o in self._observations
            if o.venue == obs.venue and o.market_id == obs.market_id
        ]
        if not prior:
            return True
        last = prior[-1]
        age = (obs.observed_at - last.observed_at).total_seconds()
        if age < min_interval_seconds and abs(last.probability - obs.probability) < 0.001:
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
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        before = len(self._observations)
        self._observations = [o for o in self._observations if _parse_ts(o.observed_at) >= cutoff]
        deleted = before - len(self._observations)
        if self.mode == "sqlite" and deleted:
            conn = self._get_sqlite_conn()
            conn.execute("DELETE FROM observations WHERE observed_at < ?", (cutoff.isoformat(),))
            conn.commit()
        if deleted:
            logger.info("Pruned %d observations older than %d days", deleted, days)
        return deleted

    def get_historical_probabilities(
        self,
        canonical_id: str,
        venue: str,
        days: int = 30,
    ) -> list[tuple[datetime, float]]:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        return [
            (_parse_ts(o.observed_at), o.probability)
            for o in self._observations
            if o.canonical_id == canonical_id
            and o.venue == venue
            and _parse_ts(o.observed_at) >= cutoff
        ]

    def max_historical_gap(
        self,
        canonical_id: str,
        venue_a: str,
        venue_b: str,
        days: int = 30,
        exclude_since: Optional[datetime] = None,
    ) -> Optional[float]:
        """Max cross-venue gap from prior polls (excludes current poll_ts observations)."""
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        series_a = [
            (_parse_ts(o.observed_at), o.probability)
            for o in self._observations
            if o.canonical_id == canonical_id
            and o.venue == venue_a
            and _parse_ts(o.observed_at) >= cutoff
            and (exclude_since is None or _ts_before(o.observed_at, exclude_since))
        ]
        series_b = [
            (_parse_ts(o.observed_at), o.probability)
            for o in self._observations
            if o.canonical_id == canonical_id
            and o.venue == venue_b
            and _parse_ts(o.observed_at) >= cutoff
            and (exclude_since is None or _ts_before(o.observed_at, exclude_since))
        ]
        if not series_a or not series_b:
            return None

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
        if self.mode == "sqlite":
            payload = signal.model_dump(mode="json")
            conn = self._get_sqlite_conn()
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
            conn.commit()

    def sync_active_opportunities(self, signals: list[Signal]) -> int:
        active_ids = {s.id for s in signals}
        for signal in signals:
            signal.is_active = True
            self._active_cache[signal.id] = signal
            if self.mode == "sqlite":
                self.upsert_signal(signal)

        self.deactivate_signals_except(active_ids)
        self._prune_stale_cache()
        self.prune_inactive_signals()
        return len(signals)

    def deactivate_signals_except(self, keep_ids: set[str]) -> int:
        stale_ids = [sid for sid in list(self._active_cache) if sid not in keep_ids]
        if not stale_ids:
            return 0

        for sid in stale_ids:
            self._active_cache.pop(sid, None)

        if self.mode == "sqlite":
            conn = self._get_sqlite_conn()
            placeholders = ",".join("?" * len(stale_ids))
            conn.execute(
                f"UPDATE signals SET is_active = 0 WHERE id IN ({placeholders})",
                stale_ids,
            )
            conn.commit()

        logger.info("Deactivated %d stale opportunities", len(stale_ids))
        return len(stale_ids)

    def prune_inactive_signals(self, retention_days: int | None = None) -> int:
        days = retention_days or self.inactive_signal_retention_days
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        if self.mode != "sqlite":
            return 0
        conn = self._get_sqlite_conn()
        cur = conn.execute(
            "DELETE FROM signals WHERE is_active = 0 AND created_at < ?",
            (cutoff,),
        )
        conn.commit()
        deleted = cur.rowcount
        if deleted:
            logger.info("Purged %d inactive signals older than %d days", deleted, days)
        return deleted

    def _prune_stale_cache(self) -> None:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=self.opportunity_max_age_hours)
        expired_ids = [
            sid
            for sid, sig in self._active_cache.items()
            if _parse_ts(sig.created_at) < cutoff
        ]
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
        candidates = sorted(
            self._active_cache.values(),
            key=lambda s: (s.score, s.created_at),
            reverse=True,
        )
        return [s for s in candidates if s.score >= min_score][:limit]

    def get_signal_by_id(self, signal_id: str) -> Optional[Signal]:
        return self._active_cache.get(signal_id)

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
            if _parse_ts(s.created_at) < cutoff:
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
        return len(self._observations)

    def count_signals(self, active_only: bool = False) -> int:
        if active_only:
            return len(self._active_cache)
        if self.mode == "sqlite":
            conn = self._get_sqlite_conn()
            row = conn.execute("SELECT COUNT(*) AS c FROM signals").fetchone()
            return int(row["c"])
        return len(self._active_cache)

    def latest_observation_time(self) -> Optional[datetime]:
        if not self._observations:
            return None
        return max(_parse_ts(o.observed_at) for o in self._observations)