import pytest

from prediction_market_engine.normalization.canonical_market import normalize_raw_market


def test_normalize_kalshi_market():
    raw = {
        "venue": "kalshi",
        "ticker": "FED-CUT-SEP-2026",
        "title": "Fed cuts rates in September 2026 meeting",
        "yes_price": 0.42,
        "volume": 125000,
        "url": "https://kalshi.com/markets/fed-cut-sep-2026",
        "topic": "Fed rates",
    }
    market = normalize_raw_market(raw)
    assert market is not None
    assert market.venue.value == "Kalshi"
    assert market.probability == 0.42
    assert market.topic == "Fed rates"
    assert "fed-rates" in market.match_key


def test_normalize_polymarket_market():
    raw = {
        "venue": "polymarket",
        "id": "poly-fed-cut-sep-2026",
        "question": "Will the Fed cut rates in September 2026?",
        "yes_price": 0.55,
        "volume": 340000,
        "url": "https://polymarket.com/event/fed-cut-sep-2026",
        "topic": "Fed rates",
    }
    market = normalize_raw_market(raw)
    assert market is not None
    assert market.venue.value == "Polymarket"
    assert market.probability == 0.55


def test_rejects_invalid_probability():
    raw = {
        "venue": "kalshi",
        "ticker": "BAD",
        "title": "Bad market",
        "yes_price": 150,
    }
    assert normalize_raw_market(raw) is None


def test_rejects_missing_title():
    raw = {"venue": "kalshi", "ticker": "X", "yes_price": 0.5}
    assert normalize_raw_market(raw) is None


def test_normalize_kalshi_live_price_fields():
    raw = {
        "venue": "kalshi",
        "ticker": "FED-CUT-SEP-2026",
        "title": "Fed cuts rates in September 2026 meeting",
        "yes_bid_dollars": "0.40",
        "yes_ask_dollars": "0.44",
        "volume_fp": "125000.00",
        "liquidity_dollars": "45000.00",
    }
    market = normalize_raw_market(raw)
    assert market is not None
    assert market.probability == pytest.approx(0.42)


def test_normalize_polymarket_live_outcome_prices_string():
    raw = {
        "venue": "polymarket",
        "id": "540817",
        "question": "Will the Fed cut rates in September 2026?",
        "outcomePrices": '["0.55", "0.45"]',
        "volumeNum": 340000,
        "liquidityNum": 120000,
    }
    market = normalize_raw_market(raw)
    assert market is not None
    assert market.probability == 0.55