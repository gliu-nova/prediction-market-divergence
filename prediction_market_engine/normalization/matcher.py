from __future__ import annotations

import logging
from dataclasses import dataclass

from prediction_market_engine.models import CanonicalMarket

logger = logging.getLogger(__name__)


@dataclass
class MatchedPair:
    match_key: str
    topic: str
    title: str
    market_a: CanonicalMarket
    market_b: CanonicalMarket


class MarketMatcher:
    """Match comparable markets across venues by normalized match_key."""

    def match_cross_venue(self, markets: list[CanonicalMarket]) -> list[MatchedPair]:
        by_key: dict[str, dict[str, CanonicalMarket]] = {}
        for m in markets:
            by_key.setdefault(m.match_key, {})[m.venue.value] = m

        pairs: list[MatchedPair] = []
        for match_key, venue_map in by_key.items():
            if len(venue_map) < 2:
                continue
            venues = sorted(venue_map.keys())
            market_a = venue_map[venues[0]]
            market_b = venue_map[venues[1]]
            pairs.append(
                MatchedPair(
                    match_key=match_key,
                    topic=market_a.topic,
                    title=market_a.title,
                    market_a=market_a,
                    market_b=market_b,
                )
            )
            logger.debug(
                "Matched %s across %s and %s",
                match_key,
                market_a.venue.value,
                market_b.venue.value,
            )
        logger.info("Matched %d cross-venue pairs from %d markets", len(pairs), len(markets))
        return pairs