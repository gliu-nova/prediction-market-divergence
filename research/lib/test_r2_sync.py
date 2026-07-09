"""Unit tests for research R2 sync helpers."""

from __future__ import annotations

from lib.r2_sync import iter_dates


def test_iter_dates_inclusive_range():
    assert iter_dates("2026-07-01", "2026-07-03") == [
        "2026-07-01",
        "2026-07-02",
        "2026-07-03",
    ]


def test_iter_dates_defaults_until_to_since():
    assert iter_dates("2026-07-09", None) == ["2026-07-09"]


def test_iter_dates_swaps_inverted_range():
    assert iter_dates("2026-07-03", "2026-07-01") == [
        "2026-07-01",
        "2026-07-02",
        "2026-07-03",
    ]
