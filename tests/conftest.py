import pytest

from prediction_market_engine.config import AppConfig
from prediction_market_engine.storage import Storage


@pytest.fixture
def config(tmp_path):
    return AppConfig(
        storage={"mode": "memory"},
        sources={"use_mock": True},
    )


@pytest.fixture
def storage(tmp_path):
    return Storage(mode="memory")