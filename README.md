# Prediction Market Divergence

Cross-venue prediction market signal engine (Kalshi ↔ Polymarket). Detects probability divergences across venues and exposes ranked opportunities via HTTP for [`Cross-Asset-Signal-Engine`](../Cross-Asset-Signal-Engine) to poll and tweet.

## Tiered architecture

| Layer | Store | Purpose |
|-------|-------|---------|
| Live / serving | **D1** | `markets`, `latest_prices`, `signals` (active opportunities), `opportunity_events`, `indicator_summaries`, `cooldowns`, `bot_posts` |
| Raw archive | **R2** | Partitioned JSONL.gz: `polymarket/markets/YYYY-MM-DD/HH-<YYYYMMDDHHMMSS>.jsonl.gz`, a daily `manifest.json` beside those objects, `kalshi/markets/...`, `polymarket/orderbooks/YYYY-MM-DD/{market_id}.jsonl.gz` |
| Research | **Local DuckDB** | Heavy percentiles, gap stats, backtest features from downloaded R2 files → compact rows pushed back to D1 |

The live bot path reads **D1 only** — never R2 or DuckDB directly.

### GitHub Actions workflows

Five workflows run on a **cron schedule**; deploy is **event-driven** (not scheduled).

| Workflow | Schedule (UTC) | Cron | Trigger |
|----------|----------------|------|---------|
| **Scheduled Ingest and Detect** | Every 30 min | `*/30 * * * *` | `POST /jobs/ingest` then `POST /jobs/detect` |
| **Market Discovery** | Every 4h at :00 | `0 */4 * * *` | `POST /jobs/discover` |
| **Summarize Indicators** | Every 12h at :00 | `0 */12 * * *` | `POST /jobs/summarize` |
| **Daily R2 DuckDB Research** | Daily 06:30 | `30 6 * * *` | `research/pm.py run-daily` |
| **Daily D1 Cleanup** | Daily 00:00 | `0 0 * * *` | `POST /maintenance/cleanup` |
| **Deploy to Cloudflare Pages** | On push to `main` | — | `wrangler pages deploy` |
| **Run Full Pipeline** | Manual only | — | discover → ingest → detect → summarize |

All scheduled workflows also support **workflow_dispatch** (manual run from GitHub Actions). Use **Run Full Pipeline** to chain the live-data jobs in order for setup, recovery, or debugging (excludes deploy, research, and cleanup).

`POST /poll` remains a backward-compatible shortcut (ingest + detect in one request).

#### Pipeline order (logical dependencies)

Jobs are independent cron triggers — GitHub does not chain them. This is the order they **should** run in for correct data flow:

```
1. Deploy (on push)          → code live on Pages
2. Discover                  → D1 markets metadata (titles, match keys)
3. Ingest                    → changed prices to R2 + D1 latest_prices
4. Detect                    → D1 signals + opportunity_events (runs immediately after ingest in poll.yml)
5. Summarize                 → D1 poll_state rollups / freshness checks
6. Research (R2 → DuckDB)    → D1 indicator_summaries (feeds detect scoring)
7. Cleanup                   → prune old D1 rows (after UTC midnight quota reset)
```

**Typical UTC day:**

| Time | What runs |
|------|-----------|
| 00:00 | Cleanup + Summarize |
| 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 | Discover |
| Every :00 and :30 | Ingest + Detect |
| 06:30 | R2 → DuckDB → D1 research |
| 12:00 | Summarize |

Discover can lag ingest by up to 4h for brand-new markets; **prices for both venues** refresh every 30 min for markets already tracked in D1. Detect skips pairs whose observation timestamps differ by more than 60 minutes.

### Ingestion caps

One Pages invocation stays inside the 128MB isolate limit. Defaults are clamped in `src/ingest-budget.ts`, so a larger dashboard value cannot reopen the old 5,000-market fetch.

| Cap | Default | Ceiling |
|-----|---------|---------|
| Kalshi pages scanned per run | 1 | 3 |
| Kalshi markets per page | 400 | 400 |
| Kalshi markets kept (highest volume in those pages) | 400 | 500 |
| Polymarket markets | 100 | 100 |
| Polymarket Gamma pages | 2 | 2 |
| Worker CPU | 60s (`[limits] cpu_ms`) | plan max |

Kalshi is fetched as one page of 400 markets. Only ticker, title, price, volume, and liquidity are kept, and the raw page is dropped before D1 and R2 writes. Ingest compares those markets to their own `latest_prices` rows and archives prices that changed. Discover writes the capped catalog archive. Neither job stores raw Kalshi pages. Ingest updates the browse snapshot in place and does not copy the previous Kalshi rows.

```
API fetch → R2 (capped JSONL.gz) + D1 (latest_prices, markets)
         → detect → D1 (signals, opportunity_events)
R2 cache → DuckDB (features) → D1 (indicator_summaries)
twitter-bot → GET /opportunities (D1 signals)
```

| Component | Technology |
|-----------|------------|
| Runtime | Cloudflare Pages Functions |
| API | Hono (`src/index.ts`) |
| Live DB | Cloudflare D1 |
| Raw history | Cloudflare R2 (`HISTORY` binding) |
| Research | Python + DuckDB (`research/pm.py`) |
| Deploy | GitHub Actions → `wrangler pages deploy` |

---

## Deploy to Cloudflare (production)

### Prerequisites

- Cloudflare account (free)
- GitHub repo for this project
- Node.js 24+ (`nvm use`)

### 1. Create D1 database

```bash
npm install
npx wrangler d1 create prediction-market-divergence
```

Copy the `database_id` into `wrangler.toml`, then:

```bash
npm run db:remote
npm run db:remote:tiered
npm run r2:create-history
```

### 2. Create Cloudflare Pages project

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Select this repo
3. Build settings:
   - **Framework preset:** None
   - **Build command:** (empty)
   - **Build output directory:** `public`
4. **Settings → Functions** → compatibility date `2026-06-10` (match `wrangler.toml`)

### 3. Bind D1 + environment variables

Pages project → **Settings** → **Bindings**:

| Type | Name | Value |
|------|------|-------|
| D1 database | `DB` | `prediction-market-divergence` |
| R2 bucket | `HISTORY` | `prediction-market-divergence-history` |

**Settings → Environment variables** (production):

| Name | Value | Notes |
|------|-------|-------|
| `USE_MOCK` | `false` | `true` for demo data |
| `MIN_DIVERGENCE_PCT_POINTS` | `5` | |
| `MIN_VOLUME` | `1000` | |
| `LOOKBACK_DAYS` | `30` | |
| `OPPORTUNITY_MAX_AGE_HOURS` | `24` | |

**Secrets**:

| Cloudflare secret name | Value |
|------------------------|-------|
| `POLL_SECRET` | Optional bearer token for `POST /jobs/*`, `/poll`, and `/maintenance/cleanup` |
| `KALSHI_ACCESS_KEY` | Kalshi API key ID (UUID from Kalshi → Account → API) |
| `KALSHI_PRIVATE_KEY` | Full RSA private key PEM downloaded when the key was created |

Set via CLI:

```bash
npx wrangler pages secret put POLL_SECRET --project-name=prediction-market-divergence
npx wrangler pages secret put KALSHI_ACCESS_KEY --project-name=prediction-market-divergence
npx wrangler pages secret put KALSHI_PRIVATE_KEY --project-name=prediction-market-divergence
```

Or in the dashboard: Pages project → **Settings** → **Variables and Secrets** → **Encrypt** → variable name exactly as above.

Kalshi requires **both** `KALSHI_ACCESS_KEY` and `KALSHI_PRIVATE_KEY`. Without them, market fetches are unauthenticated and may hit 429 rate limits. Never commit these values to git.

If `POLL_SECRET` is set, also add the same value as `POLL_SECRET` in GitHub Actions secrets (see step 4).

### 4. GitHub Actions secrets

Repo → **Settings → Secrets and variables → Actions**:

| Secret | Where to get it |
|--------|-----------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Edit Cloudflare Workers template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard URL or Workers overview |
| `POLL_SECRET` | Same value as the Pages secret (only if you set `POLL_SECRET` on Pages) |

Token needs **Cloudflare Pages Edit** + **D1 Edit**.

### 5. Scheduled jobs (GitHub Actions)

Cloudflare **Pages does not support Cron Triggers**. Ingest + detect are handled by `.github/workflows/poll.yml` (every **30 minutes** UTC).

1. Confirm workflows exist under **GitHub → Actions** (see schedule table above)
2. After the first scheduled run, verify `last_poll_at` advances on `/health`
3. Manual trigger: **Actions → Scheduled Ingest and Detect → Run workflow**

If you see **"Failed to find worker prediction-market-divergence"** in the Cloudflare dashboard, ignore it — this project is a **Pages** app, not a Worker. You do not need to create or regenerate a Worker unless you intentionally migrate polling to Workers cron.

### 6. Deploy

Every push to `main` auto-deploys via `.github/workflows/deploy.yml`.

Manual deploy:

```bash
npm run deploy
# or
./scripts/deploy.sh
```

Live URLs:

- Dashboard: `https://prediction-market-divergence.pages.dev/`
- Health: `https://prediction-market-divergence.pages.dev/health`
- Opportunities: `https://prediction-market-divergence.pages.dev/opportunities`

---

## Verify cloud polling

```bash
# Health — check last_poll_at updates every ~30 minutes
curl -s https://prediction-market-divergence.pages.dev/health | jq

# Manual poll (if POLL_SECRET set, add header)
curl -s -X POST https://prediction-market-divergence.pages.dev/poll | jq

# Opportunities
curl -s "https://prediction-market-divergence.pages.dev/opportunities?min_score=70" | jq
```

**Healthy signals:**

- `last_poll_at` advances every 30 minutes
- `sources.mode` is `live` (or `mock` if configured)
- `sources.runtime` is `cloudflare-pages`
- `status` is `ok` (or `degraded` if last poll errored — check logs)

---

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

### Example

```bash
curl -s "https://prediction-market-divergence.pages.dev/opportunities?min_score=70&min_difference_pct_points=10&topic=Fed&limit=5" | jq
```

---

## Integrating with twitter-bot

Point twitter-bot at the **public** cloud URL:

```env
# twitter-bot/.env
PMD_API_URL=https://prediction-market-divergence.pages.dev
```

twitter-bot polls `/opportunities` on each scheduled run (`prediction_markets.enabled: true` in `config.yaml`).

---

## Polymarket ingestion

Polymarket data is ingested through modular pipelines under `src/polymarket/`:

| Module | Source | Purpose |
|--------|--------|---------|
| `discovery.ts` | Gamma API | Market/event discovery + metadata |
| `clob-rest.ts` | CLOB REST | Batch prices, order books, last trade |
| `clob-ws.ts` | CLOB WebSocket | Optional near-real-time book/price/trade events (CLI) |
| `data-api.ts` | Polymarket Data API | Recent trades / activity backfill |
| `snapshot.ts` | Orchestrator | Builds normalized snapshots for poll + CLI |
| `storage-d1.ts` | Cloudflare D1 | Live Polymarket market metadata (`poly_markets`) |
| `archive/r2.ts` | Cloudflare R2 | Partitioned raw JSONL.gz archives |
| `d1/tiered.ts` | Cloudflare D1 | `markets`, `latest_prices`, `indicator_summaries`, etc. |
| `storage-local.ts` | `data/polymarket/` | Local JSON snapshots for CLI workflows |

Discover writes the capped catalog to R2. Ingest writes only changed prices. Each market archive is one object, `{source}/markets/YYYY-MM-DD/HH-<YYYYMMDDHHMMSS>.jsonl.gz`, and its key is appended to `{source}/markets/YYYY-MM-DD/manifest.json`. Compact live state stays in D1. Historical price/book detail is **not** stored long-term in D1.

### Environment variables

| Variable | Default | Notes |
|----------|---------|-------|
| `POLYMARKET_GAMMA_URL` | `https://gamma-api.polymarket.com` | Discovery |
| `POLYMARKET_CLOB_URL` | `https://clob.polymarket.com` | Prices + books |
| `POLYMARKET_CLOB_WS_URL` | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | CLI streaming |
| `POLYMARKET_DATA_API_URL` | `https://data-api.polymarket.com` | Trades backfill |
| `KALSHI_MAX_PAGES` | `1` | Kalshi pages scanned per run (ceiling 3, 400 markets each) |
| `KALSHI_MAX_MARKETS` | `400` | Kalshi markets kept per run (ceiling 500) |
| `POLYMARKET_MAX_MARKETS` | `100` | Max markets per poll/snapshot (ceiling 100) |
| `POLYMARKET_MAX_GAMMA_PAGES` | `2` | Gamma pagination cap (ceiling 2) |
| `POLYMARKET_CLOB_ENRICH_MAX` | `100` | Max markets enriched via CLOB batch prices |
| `POLYMARKET_RATE_LIMIT_MS` | `100` | Minimum interval between outbound requests |
| `POLYGON_RPC_URL` | _(unset)_ | Optional; on-chain lookups are stubbed in v1 |

### CLI examples

```bash
npm install
npm run polymarket -- discover --limit 100
npm run polymarket -- snapshot --active-only
npm run polymarket -- stream --market-id fed-cut-sep-2026 --duration-ms 15000
npm run polymarket -- backfill-trades --since 2026-06-01
npm run polymarket -- inspect-market fed-cut-sep-2026
```

Local CLI snapshots are written to `data/polymarket/snapshot-<run-id>.json` with a rolling `ingestion-runs.jsonl` index.

### Research CLI (DuckDB)

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r research/requirements.txt

cd research
python pm.py sync-r2 --since 2026-06-01      # download R2 archives locally
python pm.py build-features --since 2026-06-01
python pm.py push-d1 --since 2026-06-01      # write indicator_summaries to D1
python pm.py run-daily                       # yesterday UTC, plus the prior day for 24h change
python pm.py status
```

Or from repo root: `npm run research:daily`

Requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Sync reads each day's `manifest.json` and lists the day prefix. Listing uses the Cloudflare REST API, then downloads with `wrangler r2 object get <bucket>/<key> --file <dest> --remote`. Set `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` to list and download through the R2 S3 API instead. D1 pushes still use wrangler. The daily workflow passes the S3 secrets when they are set.

### D1 live tables (tiered)

- `markets`, `latest_prices`, `opportunity_events`, `indicator_summaries`, `cooldowns`, `bot_posts`
- `signals` — active opportunities (twitter-bot reads these)
- `poll_state` — job timestamps

Migration: `npm run db:remote:tiered`. Tables are also auto-created by `ensureTables()`.

---

## Free-tier limits to watch

| Service | Free tier (approx.) | This project's usage |
|---------|---------------------|----------------------|
| Cloudflare Pages | 500 builds/month, unlimited requests | 1 deploy per push; API reads low |
| Cloudflare Pages Functions | 100k requests/day | ~96 job POSTs/day (48 ingest + 48 detect) + API traffic |
| Cloudflare D1 | 5M rows read/day, 100k writes/day | Capped live rows. Ingest does not rewrite the Kalshi snapshot |
| Cloudflare Workers CPU | 30s default on paid | This project sets `cpu_ms = 60000` |
| Cloudflare R2 | 10 GB storage free | Raw JSONL.gz archives |
| GitHub Actions | 2000 min/month (private repos) | Deploy + ingest/detect/discover/summarize/research |

Polling + D1 should stay **$0/month** at this scale.

---

## Repo layout

```
src/                        # TypeScript cloud engine
src/jobs/                   # discover, ingest, detect, summarize
src/d1/                     # Tiered D1 storage (markets, latest_prices, indicators)
src/archive/                # R2 JSONL.gz writers
src/polymarket/             # Polymarket discovery, CLOB, snapshot modules
research/                   # DuckDB research CLI (pm.py)
scripts/polymarket-cli.ts   # Local Polymarket ingestion CLI
functions/[[path]].ts       # Pages API handler
public/                     # Dashboard static files
migrations/                 # D1 schema
wrangler.toml               # D1 + R2 bindings
.github/workflows/
  deploy.yml                # Deploy on push to main
  poll.yml                  # Ingest + detect every 30 min
  discover.yml              # Market discovery every 4h
  summarize.yml             # D1 rollup every 12h
  research-daily.yml          # R2 → DuckDB → D1 daily
  cleanup.yml               # D1 retention daily
  full-pipeline.yml         # Manual discover → ingest → detect → summarize
scripts/deploy.sh
```