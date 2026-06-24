from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, Optional

from prediction_market_engine.models import CanonicalMarket, MarketObservation, Venue, utc_now

logger = logging.getLogger(__name__)

_TOPIC_KEYWORDS = {
    "fed": "Fed rates",
    "rate": "Fed rates",
    "fomc": "Fed rates",
    "bitcoin": "Bitcoin",
    "btc": "Bitcoin",
    "recession": "Macro",
    "gdp": "Macro",
    "inflation": "Macro",
    "cpi": "Macro",
    "election": "Politics",
    "president": "Politics",
}


def _slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    text = re.sub(r"\s+", "-", text)
    return re.sub(r"-+", "-", text).strip("-")


def _infer_topic(title: str, explicit: Optional[str] = None) -> str:
    if explicit:
        return explicit
    lower = title.lower()
    for keyword, topic in _TOPIC_KEYWORDS.items():
        if keyword in lower:
            return topic
    return "General"


def _extract_title(raw: dict[str, Any], venue: str) -> str:
    if venue == "kalshi":
        return str(raw.get("title") or raw.get("event_title") or "Unknown")
    return str(raw.get("question") or raw.get("title") or raw.get("description") or "Unknown")


def _extract_market_id(raw: dict[str, Any], venue: str) -> str:
    if venue == "kalshi":
        return str(raw.get("ticker") or raw.get("market_ticker") or "")
    return str(raw.get("id") or raw.get("condition_id") or raw.get("slug") or "")


def _to_probability(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        p = float(value)
    except (TypeError, ValueError):
        return None
    if p > 100.0:
        return None
    return p / 100.0 if p > 1.0 else p


def _extract_probability(raw: dict[str, Any], venue: str) -> Optional[float]:
    if "yes_price" in raw and raw["yes_price"] is not None:
        p = _to_probability(raw["yes_price"])
        if p is not None:
            return p

    if venue == "kalshi":
        bid = _to_probability(raw.get("yes_bid_dollars"))
        ask = _to_probability(raw.get("yes_ask_dollars"))
        if bid is not None and ask is not None and bid > 0 and ask > 0:
            return (bid + ask) / 2.0
        for key in ("last_price_dollars", "yes_bid_dollars", "yes_ask_dollars"):
            p = _to_probability(raw.get(key))
            if p is not None and p > 0:
                return p

    if venue == "polymarket":
        outcomes = raw.get("outcomePrices") or raw.get("outcome_prices")
        if isinstance(outcomes, str):
            try:
                outcomes = json.loads(outcomes)
            except json.JSONDecodeError:
                outcomes = None
        if isinstance(outcomes, list) and outcomes:
            p = _to_probability(outcomes[0])
            if p is not None:
                return p
        for key in ("lastTradePrice", "bestBid", "bestAsk"):
            p = _to_probability(raw.get(key))
            if p is not None and p > 0:
                return p

    for key in ("last_price", "yes_bid", "last_price_dollars"):
        p = _to_probability(raw.get(key))
        if p is not None and p > 0:
            return p
    return None


def _extract_volume(raw: dict[str, Any]) -> Optional[float]:
    for key in (
        "volumeNum",
        "volume",
        "volume_fp",
        "volume_24h_fp",
        "volume_24h",
        "volume24hr",
        "total_volume",
    ):
        if raw.get(key) is not None:
            try:
                return float(raw[key])
            except (TypeError, ValueError):
                continue
    return None


def _extract_liquidity(raw: dict[str, Any]) -> Optional[float]:
    for key in ("liquidityNum", "liquidity", "liquidity_dollars", "open_interest", "liquidity_usd"):
        if raw.get(key) is not None:
            try:
                return float(raw[key])
            except (TypeError, ValueError):
                continue
    return None


def _extract_url(raw: dict[str, Any], venue: str, market_id: str) -> str:
    if raw.get("url"):
        return str(raw["url"])
    if venue == "kalshi":
        return f"https://kalshi.com/markets/{market_id.lower()}"
    slug = raw.get("slug") or market_id
    return f"https://polymarket.com/event/{slug}"


def _build_match_key(title: str, topic: str) -> str:
    title_slug = _slugify(title)
    topic_slug = _slugify(topic)
    # Strip venue-specific prefixes for cross-venue matching
    for prefix in ("will-the-", "will-", "us-"):
        if title_slug.startswith(prefix):
            title_slug = title_slug[len(prefix) :]
    return f"{topic_slug}:{title_slug}"


def normalize_raw_market(raw: dict[str, Any], observed_at: Optional[datetime] = None) -> Optional[CanonicalMarket]:
    venue_str = str(raw.get("venue", "")).lower()
    if venue_str == "kalshi":
        venue = Venue.KALSHI
    elif venue_str == "polymarket":
        venue = Venue.POLYMARKET
    else:
        logger.warning("Unknown venue in raw market: %s", venue_str)
        return None

    market_id = _extract_market_id(raw, venue_str)
    title = _extract_title(raw, venue_str)
    if not market_id or not title or title == "Unknown":
        logger.warning("Skipping malformed %s market: missing id or title", venue_str)
        return None

    probability = _extract_probability(raw, venue_str)
    if probability is None:
        logger.warning("Skipping %s market %s: no probability", venue_str, market_id)
        return None
    if not 0.0 <= probability <= 1.0:
        logger.warning("Skipping %s market %s: invalid probability %s", venue_str, market_id, probability)
        return None

    topic = _infer_topic(title, raw.get("topic"))
    match_key = raw.get("match_key") or raw.get("canonical_id") or _build_match_key(title, topic)
    canonical_id = match_key

    ts = observed_at or utc_now()
    if isinstance(raw.get("fetched_at"), str):
        try:
            ts = datetime.fromisoformat(raw["fetched_at"])
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
        except ValueError:
            pass

    return CanonicalMarket(
        canonical_id=canonical_id,
        title=title,
        topic=topic,
        venue=venue,
        market_id=market_id,
        probability=probability,
        volume=_extract_volume(raw),
        liquidity=_extract_liquidity(raw),
        url=_extract_url(raw, venue_str, market_id),
        observed_at=ts,
        match_key=match_key,
    )


def to_observation(market: CanonicalMarket) -> MarketObservation:
    return MarketObservation(
        venue=market.venue.value,
        market_id=market.market_id,
        canonical_id=market.canonical_id,
        title=market.title,
        topic=market.topic,
        probability=market.probability,
        volume=market.volume,
        liquidity=market.liquidity,
        url=market.url,
        observed_at=market.observed_at,
    )