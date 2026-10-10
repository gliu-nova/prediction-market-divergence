"""Unit tests for indicator summary SQL and the daily lookback window."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import duckdb

from lib.features import compute_indicator_summaries, indicator_since, load_snapshots_into_duckdb


def _table(rows: list[tuple]) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(
        """
        CREATE TABLE market_snapshots (
          venue TEXT, market_id TEXT, match_key TEXT, topic TEXT,
          probability DOUBLE, volume DOUBLE, liquidity DOUBLE,
          observed_at TEXT, ingest_ts TEXT
        )
        """
    )
    con.executemany("INSERT INTO market_snapshots VALUES (?,?,?,?,?,?,?,?,?)", rows)
    return con


def _by_venue(summaries: list[dict]) -> dict[str, dict]:
    return {row["venue"]: row for row in summaries}


def test_indicator_since_is_the_previous_utc_day():
    assert indicator_since("2026-10-09") == "2026-10-08"


def test_one_hour_and_one_day_changes_use_both_cutoffs():
    con = _table(
        [
            ("polymarket", "m1", "mk", "t", 0.20, 9, 1, "2026-10-08T14:00:00Z", "2026-10-08T14:00:00Z"),
            ("polymarket", "m1", "mk", "t", 0.40, 10, 1, "2026-10-09T10:00:00Z", "2026-10-09T10:00:00Z"),
            ("polymarket", "m1", "mk", "t", 0.55, 12, 1, "2026-10-09T14:00:00Z", "2026-10-09T14:00:00Z"),
            ("kalshi", "k1", "mk", "t", 0.50, 8, 1, "2026-10-09T14:00:00Z", "2026-10-09T14:00:00Z"),
        ]
    )
    rows = _by_venue(compute_indicator_summaries(con, "2026-10-10T12:46:00+00:00"))
    poly = rows["polymarket"]
    assert abs(poly["prob_change_1h"] - 15) < 1e-9
    assert abs(poly["prob_change_24h"] - 35) < 1e-9
    assert rows["kalshi"]["prob_change_1h"] is None
    assert rows["kalshi"]["prob_change_24h"] is None
    con.close()


def test_same_day_rows_leave_the_24h_change_empty():
    con = _table(
        [
            ("polymarket", "m1", "mk", "t", 0.40, 10, 1, "2026-10-09T10:00:00Z", "2026-10-09T10:00:00Z"),
            ("polymarket", "m1", "mk", "t", 0.55, 12, 1, "2026-10-09T14:00:00Z", "2026-10-09T14:00:00Z"),
        ]
    )
    rows = compute_indicator_summaries(con, "2026-10-10T12:46:00+00:00")
    assert abs(rows[0]["prob_change_1h"] - 15) < 1e-9
    assert rows[0]["prob_change_24h"] is None
    con.close()


def test_load_snapshots_keeps_the_lookback_day():
    from tempfile import TemporaryDirectory

    def write(directory: Path, day: str, hour: str, probability: float) -> None:
        key = directory / "polymarket" / "markets" / day / f"{hour}.jsonl.gz"
        key.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "ingest_ts": f"{day}T{hour}:00:00Z",
            "venue": "polymarket",
            "markets": [
                {
                    "market_id": "m1",
                    "match_key": "mk",
                    "topic": "t",
                    "probability": probability,
                    "volume": 1,
                    "liquidity": 1,
                    "observed_at": f"{day}T{hour}:00:00Z",
                }
            ],
        }
        with gzip.open(key, "wt", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")

    with TemporaryDirectory() as directory:
        root = Path(directory)
        write(root, "2026-10-08", "14", 0.2)
        write(root, "2026-10-09", "14", 0.55)
        write(root, "2026-10-07", "14", 0.1)
        con = duckdb.connect()
        count = load_snapshots_into_duckdb(con, root, indicator_since("2026-10-09"), "2026-10-09")
        assert count == 2
        rows = _by_venue(compute_indicator_summaries(con, "2026-10-10T12:46:00+00:00"))
        assert abs(rows["polymarket"]["prob_change_24h"] - 35) < 1e-9
        con.close()
