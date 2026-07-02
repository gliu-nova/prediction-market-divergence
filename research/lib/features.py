"""Compute compact indicator summaries from archived market snapshots."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import duckdb


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def load_snapshots_into_duckdb(con: duckdb.DuckDBPyConnection, cache_dir: Path, since: str, until: str | None) -> int:
    files = sorted(cache_dir.rglob("*.jsonl.gz"))
    rows: list[tuple] = []
    for path in files:
        day = path.parts[-2] if len(path.parts) >= 2 else ""
        if day < since:
            continue
        if until and day > until:
            continue
        import gzip

        with gzip.open(path, "rt", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                ingest_ts = rec.get("ingest_ts") or rec.get("poll_ts")
                if not ingest_ts:
                    continue
                if ingest_ts[:10] < since:
                    continue
                if until and ingest_ts[:10] > until:
                    continue
                for m in rec.get("markets", []):
                    rows.append(
                        (
                            rec.get("venue", "unknown"),
                            m.get("market_id"),
                            m.get("match_key"),
                            m.get("topic"),
                            float(m.get("probability", 0)),
                            m.get("volume"),
                            m.get("liquidity"),
                            m.get("observed_at") or ingest_ts,
                            ingest_ts,
                        )
                    )
    if not rows:
        return 0

    con.execute(
        """
        CREATE OR REPLACE TABLE market_snapshots (
          venue TEXT,
          market_id TEXT,
          match_key TEXT,
          topic TEXT,
          probability DOUBLE,
          volume DOUBLE,
          liquidity DOUBLE,
          observed_at TEXT,
          ingest_ts TEXT
        )
        """
    )
    con.executemany("INSERT INTO market_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    return len(rows)


def compute_indicator_summaries(con: duckdb.DuckDBPyConnection, computed_at: str) -> list[dict]:
    con.execute(
        """
        CREATE OR REPLACE TABLE indicator_out AS
        WITH parsed AS (
          SELECT
            match_key,
            venue,
            probability,
            volume,
            liquidity,
            try_cast(observed_at AS TIMESTAMP) AS obs_ts,
            try_cast(ingest_ts AS TIMESTAMP) AS ingest_ts
          FROM market_snapshots
          WHERE match_key IS NOT NULL AND match_key != ''
        ),
        latest AS (
          SELECT match_key, venue, probability AS prob_now, volume AS vol_now
          FROM (
            SELECT *, row_number() OVER (PARTITION BY match_key, venue ORDER BY ingest_ts DESC) AS rn
            FROM parsed
          ) t WHERE rn = 1
        ),
        hist_1h AS (
          SELECT p.match_key, p.venue, p.probability AS prob_1h
          FROM parsed p
          JOIN latest l ON l.match_key = p.match_key AND l.venue = p.venue
          WHERE p.ingest_ts <= l.ingest_ts - INTERVAL 1 HOUR
          QUALIFY row_number() OVER (PARTITION BY p.match_key, p.venue ORDER BY p.ingest_ts DESC) = 1
        ),
        hist_24h AS (
          SELECT p.match_key, p.venue, p.probability AS prob_24h
          FROM parsed p
          JOIN latest l ON l.match_key = p.match_key AND l.venue = p.venue
          WHERE p.ingest_ts <= l.ingest_ts - INTERVAL 24 HOUR
          QUALIFY row_number() OVER (PARTITION BY p.match_key, p.venue ORDER BY p.ingest_ts DESC) = 1
        ),
        gap_stats AS (
          SELECT
            a.match_key,
            max(abs(a.probability - b.probability) * 100) AS max_gap_30d
          FROM market_snapshots a
          JOIN market_snapshots b
            ON a.match_key = b.match_key
           AND a.venue != b.venue
           AND a.ingest_ts = b.ingest_ts
          GROUP BY 1
        )
        SELECT
          l.match_key,
          l.venue,
          (l.prob_now - h1.prob_1h) * 100 AS prob_change_1h,
          (l.prob_now - h24.prob_24h) * 100 AS prob_change_24h,
          g.max_gap_30d,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY l.vol_now) OVER () AS volume_p50
        FROM latest l
        LEFT JOIN hist_1h h1 ON h1.match_key = l.match_key AND h1.venue = l.venue
        LEFT JOIN hist_24h h24 ON h24.match_key = l.match_key AND h24.venue = l.venue
        LEFT JOIN gap_stats g ON g.match_key = l.match_key
        """
    )
    out = con.execute("SELECT * FROM indicator_out").fetchall()
    cols = [d[0] for d in con.description] if con.description else []
    summaries: list[dict] = []
    for row in out:
        rec = dict(zip(cols, row))
        summaries.append(
            {
                "match_key": rec["match_key"],
                "venue": rec["venue"],
                "computed_at": computed_at,
                "prob_change_1h": rec.get("prob_change_1h"),
                "prob_change_24h": rec.get("prob_change_24h"),
                "max_gap_30d": rec.get("max_gap_30d"),
                "volume_p50": rec.get("volume_p50"),
                "spread_p50": None,
                "similar_events_count": None,
                "reversion_rate": None,
            }
        )
    con.execute(
        """
        CREATE OR REPLACE TABLE indicator_summaries_export (
          match_key TEXT,
          venue TEXT,
          computed_at TEXT,
          prob_change_1h DOUBLE,
          prob_change_24h DOUBLE,
          max_gap_30d DOUBLE,
          spread_p50 DOUBLE,
          volume_p50 DOUBLE,
          similar_events_count INTEGER,
          reversion_rate DOUBLE
        )
        """
    )
    if summaries:
        con.executemany(
            "INSERT INTO indicator_summaries_export VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    s["match_key"],
                    s["venue"],
                    s["computed_at"],
                    s.get("prob_change_1h"),
                    s.get("prob_change_24h"),
                    s.get("max_gap_30d"),
                    s.get("spread_p50"),
                    s.get("volume_p50"),
                    s.get("similar_events_count"),
                    s.get("reversion_rate"),
                )
                for s in summaries
            ],
        )
    return summaries