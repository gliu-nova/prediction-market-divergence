# Initial Prompt — prediction-market-divergence

I want to build a new project called `prediction-market-divergence`.

## Goal

Build a standalone prediction-market signal engine/service that constantly monitors and ingests prediction market data (such as polymarket and kalshi), detects cross-market disagreements/arbitrage-like divergences, significant pricing inefficiencies, arbitrage opportunities, and exposes clean signal outputs to my existing `twitter-bot` project via API such that my existing twitter bot can query or consume the results easily.

## Important context

* This should be a separate project, not merged into my existing twitter bot.
* The first version should prioritize correctness, clean architecture, and useful signals over low latency.
* Use Python for the MVP unless there is a strong reason to use Rust such as data fetching hot paths, detection logic, in-memory state, etc.
* Expose a lightweight API (consider using Axum or Actix Web) that the twitter bot can poll on a schedule.
* Keep the service stateless or lightly stateful (in-memory cache of recent opportunities + optional simple persistence).
* Make it easy to extend later (add more venues like Kalshi, feed into a central stream processor, add WebSocket push, etc.).

## Core functionality

1. Ingest prediction market data from sources such as Kalshi and Polymarket.
2. Normalize markets into a common schema.
3. Match comparable markets across venues when possible.
4. Detect divergences such as:
   * Same/similar event priced differently across venues
   * Sudden probability repricing
   * Large probability gap vs recent history. Cross-outcome or related-market inefficiencies (probabilities that don't sum correctly in multi-outcome or neg-risk markets).
   * Market odds moving while related financial asset is not moving.
   * Large spreads or liquidity imbalances that could be arbitraged.
   Start simple and make the detection logic modular so it's easy to improve.
5. Store historical observations locally.
6. Score signals by unusualness and usefulness.
7. Expose latest signals through an API endpoint that my twitter bot can poll.

## Suggested stack

* Python, Rust (latest stable)
* FastAPI for API
* Tokio + Axum (or Actix) for async + HTTP server.
* SQLite or DuckDB for local historical storage
* Pydantic models for typed schemas
* Requests/httpx for API calls
* APScheduler or simple scheduled polling loop
* pytest for tests
* Reqwest or a dedicated Polymarket client crate for API calls.
* Serde for JSON.
* Tracing or log for logging.
* Optional: polars or simple structs for in-memory analysis if needed.
* Use existing community crates where they help (search for current Polymarket Rust clients if useful).

## API requirements

Create endpoints such as:

**GET /signals/latest** — Returns latest ranked prediction-market signals.

**GET /signals?min_score=...** — Returns recent signals above a threshold.

**GET /opportunities** — Returns current active opportunities (filterable by min_profit, min_volume, etc.). Should support filters such as:
   * min_score
   * min_difference_pct_points
   * min_volume
   * venue
   * topic
   * limit

**GET /opportunities/{id}** — Details for one opportunity.

**GET /markets** or health/status endpoint.

Return well-structured JSON that my Twitter bot can easily turn into tweets (include fields like title, yes_price_a, yes_price_b, implied_arb_profit_pct, volume, url, detected_at, etc.).

### Example signal JSON

```json
{
  "id": "kalshi_polymarket_fed_cut_2026_06_24",
  "type": "prediction_market_divergence",
  "title": "FED CUT ODDS DIVERGE",
  "asset_or_topic": "Fed rates",
  "market_a": {
    "venue": "Kalshi",
    "probability": 0.42,
    "url": "..."
  },
  "market_b": {
    "venue": "Polymarket",
    "probability": 0.55,
    "url": "..."
  },
  "difference_pct_points": 13.0,
  "lookback_context": "Largest gap in 30 days",
  "score": 87,
  "created_at": "ISO_TIMESTAMP",
  "tweet_hint": "Kalshi and Polymarket disagree by 13 pts on September Fed cut odds."
}
```

## Architecture

Use these modules/directories:

```
prediction_market_engine/
  app.py
  config.py
  models.py
  storage.py
  sources/
    kalshi.py
    polymarket.py
  normalization/
    canonical_market.py
    matcher.py
  signals/
    divergence.py
    repricing.py
    scoring.py
  api/
    routes.py
tests/
```

## Implementation requirements

* Keep source adapters separate from signal logic.
* Do not hardcode everything into one script.
* Add clear logging.
* Add error handling for API failures, empty responses, stale data, and malformed data.
* Avoid posting to Twitter directly from this project.
* This project only produces structured signals.
* The existing twitter bot will consume those signals and decide whether/how to post.
* Include basic metrics or simple logging of how many opportunities were found.

## MVP behavior

* Start with mocked/sample data if live APIs are inconvenient.
* Then implement real adapters one at a time.
* First working signal should be cross-venue probability divergence.
* Store each market observation with timestamp, venue, market_id, title, probability, volume/liquidity if available, and source URL.
* Rank signals by difference size, liquidity, recency, and rarity if historical data exists.

## Deliverables

The service should return structured data that is directly useful for generating high-quality tweets (include all the fields the bot would need: market description, prices on both sides or venues, potential edge/profit, liquidity info, links).
Document in the README exactly how the Twitter bot should call the API (example curl or pseudocode is fine).

1. Working FastAPI service.
2. Local storage layer.
3. Example source adapter.
4. Example divergence detector.
5. `/signals/latest` endpoint returning realistic JSON.
6. README with setup instructions.
7. Tests for normalization, matching, and signal scoring.

Please implement this incrementally with clean commits/sections:

* Step 1: project skeleton
* Step 2: models and storage
* Step 3: mock source ingestion
* Step 4: divergence detector
* Step 5: API endpoints
* Step 6: README and tests