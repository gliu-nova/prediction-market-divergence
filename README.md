# Prediction Market Divergence

Cross-venue prediction market signal engine (Kalshi ↔ Polymarket). Detects probability divergences, stores history in Cloudflare D1, and exposes ranked opportunities via HTTP for [`twitter-bot`](../twitter-bot) to poll and tweet.

## Architecture

| Component | Technology |
|-----------|------------|
| Runtime | Cloudflare Pages Functions + Cron |
| API | Hono (`src/index.ts`, `functions/`) |
| Database | Cloudflare D1 (SQLite) |
| Deploy | GitHub Actions → `wrangler pages deploy` |
| Polling | Cron every 15 min (`functions/_scheduled.ts`) |

```
GitHub (main push)
    → GitHub Actions deploy
        → Cloudflare Pages (public API + dashboard)
            → Cron */15 * * * * → poll Kalshi/Polymarket
            → D1 (observations + signals + poll_state)
twitter-bot
    → GET https://prediction-market-divergence.pages.dev/opportunities
```

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

**Settings → Environment variables** (production):

| Name | Value | Notes |
|------|-------|-------|
| `USE_MOCK` | `false` | `true` for demo data |
| `MIN_DIVERGENCE_PCT_POINTS` | `5` | |
| `MIN_VOLUME` | `1000` | |
| `LOOKBACK_DAYS` | `30` | |
| `OPPORTUNITY_MAX_AGE_HOURS` | `24` | |

**Secrets** (optional but recommended):

```bash
npx wrangler pages secret put POLL_SECRET --project-name=prediction-market-divergence
```

Protects `POST /poll`. Cron polls do not need this.

### 4. GitHub Actions secrets

Repo → **Settings → Secrets and variables → Actions**:

| Secret | Where to get it |
|--------|-----------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Edit Cloudflare Workers template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard URL or Workers overview |

Token needs **Cloudflare Pages Edit** + **D1 Edit**.

### 5. Cron trigger

Pages does not support `[triggers]` in `wrangler.toml` (that is Workers-only). Set the schedule in the dashboard:

1. **Workers & Pages** → `prediction-market-divergence` → **Settings** → **Cron Triggers**
2. Add or edit: `*/15 * * * *` (every 15 minutes UTC)
3. Handler: `functions/_scheduled.ts` (`onSchedule`)

After deploy, confirm the dashboard shows `*/15 * * * *`.

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
# Health — check last_poll_at updates every ~15 minutes
curl -s https://prediction-market-divergence.pages.dev/health | jq

# Manual poll (if POLL_SECRET set, add header)
curl -s -X POST https://prediction-market-divergence.pages.dev/poll | jq

# Opportunities
curl -s "https://prediction-market-divergence.pages.dev/opportunities?min_score=70" | jq
```

**Healthy signals:**

- `last_poll_at` advances every 15 minutes
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

## Free-tier limits to watch

| Service | Free tier (approx.) | This project's usage |
|---------|---------------------|----------------------|
| Cloudflare Pages | 500 builds/month, unlimited requests | 1 deploy per push; API reads low |
| Cloudflare Workers (Functions) | 100k requests/day | Cron 96/day + API traffic |
| Cloudflare D1 | 5M rows read/day, 100k writes/day | ~6 markets/poll × 96 ≈ 576 obs/day |
| GitHub Actions | 2000 min/month (private) | Deploy-only (~1 min/deploy) |

Cron + D1 should stay **$0/month** at this scale.

---

## Repo layout

```
src/                        # TypeScript cloud engine
functions/
  [[path]].ts               # Pages API handler
  _scheduled.ts             # Cron poll handler (every 15 min)
public/                     # Dashboard static files
migrations/                 # D1 schema
wrangler.toml               # Cloudflare Pages config (D1, vars; cron via dashboard)
.github/workflows/deploy.yml
scripts/deploy.sh
```