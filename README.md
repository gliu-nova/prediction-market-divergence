# Prediction Market Divergence

Standalone signal engine that monitors prediction markets (Polymarket, Kalshi), detects cross-venue probability divergences, stores historical observations, and exposes ranked signals via FastAPI for the [`twitter-bot`](../twitter-bot) project to poll and tweet.

## Architecture

```
prediction_market_engine/
  app.py              # FastAPI app + scheduler
  config.py           # YAML + env config
  models.py           # Pydantic schemas
  storage.py          # SQLite persistence
  engine.py           # Poll orchestration
  sources/            # Venue adapters (mock, Kalshi, Polymarket)
  normalization/      # Canonical schema + cross-venue matcher
  signals/            # Divergence detection + scoring
  api/                # HTTP routes
tests/
```

## Quick start

```bash
cd prediction-market-divergence
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

Service listens on `http://0.0.0.0:8080` by default. Mock data is enabled in `config.yaml` (`sources.use_mock: true`).

### One-shot poll (no server)

```bash
python run.py --poll-once
```

### Run tests

```bash
pytest -v
```

## API endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Service health + source status |
| `GET /status` | Alias for `/health` |
| `GET /markets` | Markets tracked summary |
| `GET /signals/latest` | Latest ranked signals |
| `GET /signals?min_score=70` | Signals above score threshold |
| `GET /signals/{id}` | Single signal detail |
| `GET /opportunities` | Active opportunities (filterable) |
| `GET /opportunities/{id}` | Single opportunity detail |
| `POST /poll` | Trigger manual poll cycle |

### Example: latest signals

```bash
curl -s http://localhost:8080/signals/latest | jq
```

### Example: filtered opportunities

```bash
curl -s "http://localhost:8080/opportunities?min_score=70&min_difference_pct_points=10&topic=Fed&limit=5" | jq
```

### Example signal JSON

```json
{
  "id": "kalshi_polymarket_fed_rates_fed_cut_sep_2026_2026_06_24",
  "type": "prediction_market_divergence",
  "title": "FED RATES ODDS DIVERGE",
  "asset_or_topic": "Fed rates",
  "market_a": {
    "venue": "Kalshi",
    "probability": 0.42,
    "url": "https://kalshi.com/markets/fed-cut-sep-2026",
    "market_id": "FED-CUT-SEP-2026",
    "volume": 125000,
    "liquidity": 45000
  },
  "market_b": {
    "venue": "Polymarket",
    "probability": 0.55,
    "url": "https://polymarket.com/event/fed-cut-sep-2026",
    "market_id": "poly-fed-cut-sep-2026",
    "volume": 340000,
    "liquidity": 120000
  },
  "difference_pct_points": 13.0,
  "implied_arb_profit_pct": 13.0,
  "lookback_context": "First cross-venue observation",
  "score": 87,
  "created_at": "2026-06-24T12:00:00+00:00",
  "tweet_hint": "Kalshi and Polymarket disagree by 13 pts on fed rates odds.",
  "is_active": true
}
```

## Integrating with twitter-bot

Poll this service on a schedule (e.g. every 5–15 minutes) from your existing bot. This project does **not** post to Twitter — it only produces structured signals.

### Python example (twitter-bot consumer)

```python
import os
import requests

PMD_BASE = os.getenv("PMD_API_URL", "http://localhost:8080")

def fetch_prediction_signals(min_score: int = 70) -> list[dict]:
    resp = requests.get(
        f"{PMD_BASE}/opportunities",
        params={"min_score": min_score, "limit": 10},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()["opportunities"]

def signal_to_tweet(signal: dict) -> str:
    a, b = signal["market_a"], signal["market_b"]
    return (
        f"{signal['title']}\n\n"
        f"{a['venue']}: {a['probability']*100:.0f}%\n"
        f"{b['venue']}: {b['probability']*100:.0f}%\n"
        f"Gap: {signal['difference_pct_points']:.0f} pts\n\n"
        f"{signal.get('lookback_context', '')}\n"
        f"→ {signal['tweet_hint']}"
    )

# In your bot's scheduled run:
for opp in fetch_prediction_signals(min_score=75):
    tweet = signal_to_tweet(opp)
    # pass to your existing posting engine / dedup logic
```

### curl health check (CI / cron)

```bash
curl -sf http://localhost:8080/health | jq '.status'
```

### Recommended env for twitter-bot

```env
PMD_API_URL=http://localhost:8080
```

Run the divergence service separately (local, Docker, or a small VM). Point `PMD_API_URL` at it.

## Configuration

Edit `config.yaml`:

```yaml
sources:
  use_mock: true          # set false for live Kalshi/Polymarket APIs

detection:
  min_divergence_pct_points: 5.0
  min_volume: 1000.0

service:
  poll_interval_seconds: 300
```

Env overrides: `PMD_HOST`, `PMD_PORT`, `PMD_USE_MOCK`.

## MVP scope

- Mock ingestion with realistic Fed/BTC/recession markets
- Cross-venue divergence detection (primary signal)
- SQLite history for observations + signals
- Modular source adapters (swap mock → live one venue at a time)
- Repricing detector stub (logged, not yet API-surfaced)

## Live APIs

Set `sources.use_mock: false` in `config.yaml`. Kalshi and Polymarket adapters call public REST endpoints; malformed or empty responses are logged and skipped without crashing the poll cycle.

## Future extensions

- WebSocket push to twitter-bot
- Additional venues
- Fuzzy market matching / manual mapping table
- Neg-risk / multi-outcome sum inefficiency detector
- Rust hot-path service (if latency becomes critical)