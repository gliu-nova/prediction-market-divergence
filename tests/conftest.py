import pytest

from prediction_market_engine.config import AppConfig
from prediction_market_engine.storage import Storage


@pytest.fixture
def config(tmp_path):
    return AppConfig(
        storage={"db_path": str(tmp_path / "test.db")},
        sources={"use_mock": True},
    )


@pytest.fixture
def storage(tmp_path):
    return Storage(str(tmp_path / "test.db"))