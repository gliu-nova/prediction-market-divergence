# Goal 1 Prompt — prediction-market intelligence engine

Build a prediction-market intelligence engine that discovers unusual market disagreements, pricing anomalies, and cross-market divergences.

The engine/service should ingest data from sources such as Kalshi and Polymarket, normalize markets into a common schema, store historical observations, and rank opportunities by significance. The engine/service must feed structured opportunity data to my existing Twitter bot project via simple HTTP API calls (the bot will poll `/opportunities` on a schedule). Prioritize performance, reliability, and clean code for a long-running process.

Success is measured by signal quality, not feature count.

## Favor

* useful signals over complex architecture
* explainable opportunities over black-box scoring
* a small number of high-quality alerts over many noisy alerts
* clean APIs that can integrate with my existing twitter-bot project

The system should be designed as production-quality market infrastructure with clear ingestion, normalization, storage, scoring, and API layers.

## Key MVP features

* Fetch active markets and real-time prices/order books.
* Detect meaningful arb/inefficiency signals (cross-outcome, related markets, spreads, etc.) with configurable thresholds.
* In-memory (and optional light persistence) storage of opportunities with rich metadata (prices, implied profit, liquidity, links, timestamp).
* REST API endpoints: `GET /opportunities` (list with filters), `GET /opportunities/{id}`.
* Return JSON optimized for the Twitter bot to generate high-quality tweets.
* Config via env vars (polling interval, min profit threshold, etc.).
* Proper logging, error handling, retries, and rate limit awareness.

## When making design decisions, optimize for

1. Generating interesting opportunities that traders would care about
2. Supporting historical analysis and context
3. Easy integration with RPM
4. Learning systems engineering concepts and patterns
5. Future migration of performance-critical components to Rust if needed

Do not overengineer early. Build the simplest version that produces useful opportunities first, then iterate.