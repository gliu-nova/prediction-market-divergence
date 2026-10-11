"""Tests for the D1 indicator push row reader."""

from __future__ import annotations

import duckdb

from lib.d1_push import _fetchdf_rows, read_indicator_rows, rows_from_records, sql_num


def _connection() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(
        """
        CREATE TABLE indicator_summaries_export (
          match_key VARCHAR,
          venue VARCHAR,
          computed_at VARCHAR,
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
    con.execute(
        """
        INSERT INTO indicator_summaries_export VALUES
        ('mk', 'polymarket', '2026-10-11T00:00:00+00:00', 1.5, NULL, NULL, NULL, 10, NULL, NULL)
        """
    )
    return con


def test_sql_num_writes_null_for_missing_and_nan():
    assert sql_num(None) == "NULL"
    assert sql_num(float("nan")) == "NULL"
    assert sql_num(1.5) == "1.5"


def test_records_from_a_dataframe_turn_nan_into_none():
    rows = rows_from_records(
        [
            {
                "prob_change_1h": 1.5,
                "prob_change_24h": float("nan"),
                "similar_events_count": None,
            }
        ]
    )
    assert rows == [
        {"prob_change_1h": 1.5, "prob_change_24h": None, "similar_events_count": None}
    ]


def test_read_indicator_rows_keeps_sql_null_without_fetchdf():
    con = _connection()
    rows = read_indicator_rows(con)
    assert rows == [
        {
            "match_key": "mk",
            "venue": "polymarket",
            "computed_at": "2026-10-11T00:00:00+00:00",
            "prob_change_1h": 1.5,
            "prob_change_24h": None,
            "max_gap_30d": None,
            "spread_p50": None,
            "volume_p50": 10.0,
            "similar_events_count": None,
            "reversion_rate": None,
        }
    ]
    assert sql_num(rows[0]["prob_change_24h"]) == "NULL"
    con.close()


class _Result:
    def __init__(self, error: Exception):
        self.error = error

    def fetchdf(self):
        raise self.error


class _Connection:
    def __init__(self, error: Exception):
        self.error = error

    def execute(self, query):
        return _Result(self.error)


def test_fetchdf_is_skipped_when_numpy_or_pandas_is_missing():
    assert _fetchdf_rows(_Connection(ModuleNotFoundError("No module named 'numpy'")), "q") is None
    assert _fetchdf_rows(
        _Connection(RuntimeError("pandas is required for this operation but it was not installed")),
        "q",
    ) is None


def test_fetchdf_does_not_swallow_unrelated_errors():
    try:
        _fetchdf_rows(_Connection(RuntimeError("disk full")), "q")
    except RuntimeError as exc:
        assert "disk full" in str(exc)
    else:
        raise AssertionError("expected the unrelated fetchdf error to propagate")
