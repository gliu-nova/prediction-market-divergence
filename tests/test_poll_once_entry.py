"""Drive the real run.py --poll-once entry point."""

import os
import subprocess
import sys

import pytest

from prediction_market_engine.config import AppConfig
from prediction_market_engine.engine import PredictionMarketEngine


def test_poll_once_engine_fed_score_87():
    """Real engine.poll() path (same as run.py --poll-once) yields ~87 for Fed mock."""
    cfg = AppConfig(
        storage={"mode": "memory"},
        sources={"use_mock": True},
    )
    engine = PredictionMarketEngine(cfg)
    count = engine.poll()
    assert count == 1
    opp = engine.storage.get_opportunities(min_score=0, topic="Fed")[0]
    assert opp.difference_pct_points == 13.0
    assert opp.score == pytest.approx(87, abs=1)


def test_poll_once_subprocess_entry(tmp_path):
    """Subprocess run.py --poll-once with memory mode (real CLI entry)."""
    env = os.environ.copy()
    env["PMD_STORAGE_MODE"] = "memory"
    env["PMD_USE_MOCK"] = "1"
    root = os.path.dirname(os.path.dirname(__file__))
    result = subprocess.run(
        [sys.executable, "run.py", "--poll-once"],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "Poll complete: 1 opportunities found" in result.stdout
    assert "score=87" in result.stdout + result.stderr or "13.0 pp" in result.stdout + result.stderr