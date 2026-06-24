# Prediction Market Divergence

Cross-venue prediction market signal engine (Kalshi ↔ Polymarket). Detects probability divergences, stores history, and exposes ranked opportunities via HTTP for [`twitter-bot`](../twitter-bot) to poll and tweet.

## Architecture comparison

| | **prediction-market-divergence** (this repo) | **wacta-scoring** (reference) |
|---|---|---|
| Runtime | Cloudflare Pages Functions + Cron | Cloudflare Pages Functions |
| API | Hono (`src/index.ts`, `functions/`) | Hono (`src/index.ts`, `functions/api/`) |
| Database | Cloudflare D1 (SQLite) | Cloudflare D1 |
| Deploy | GitHub Actions → `wrangler pages deploy` | Same |
| Polling | Cron every 5 min (`functions/_scheduled.ts`) | N/A (user-driven CRUD) |
| Local dev | `npm run dev` (cloud stack) or `python run.py` (legacy) | `npm run dev` |

## Recommended cloud approach (implemented)

**Option A: Cloudflare Pages Cron + D1** ✅

Why this beats **Option B (GitHub Actions polling)**:

| Criteria | Option A (chosen) | Option B |
|---|---|---|
| Cost | Workers/Pages/D1 free tiers | ~288 GHA runs/day burns minutes on private repos |
| Laptop required | No | No |
| Always-on API | Yes (`*.pages.dev`) | Needs separate Worker anyway |
| Similar to wacta-scoring | Yes (Pages + D1 + Hono + GitHub deploy) | Partial |
| Code rewrite | TypeScript poll engine added; Python kept for local/tests | Minimal Python change |

The cloud stack mirrors wacta-scoring. Python FastAPI remains for local development and unit tests only.

```
GitHub (main push)
    → GitHub Actions deploy
        → Cloudflare Pages (public API + dashboard)
            → Cron */5 * * * * → poll Kalshi/Polymarket
            → D1 (observations + signals + poll_state)
twitter-bot
    → GET https://YOUR.pages.dev/opportunities
```

---

## Deploy to Cloudflare (production)

### Prerequisites

- Cloudflare account (free)
- GitHub repo for this project
- Node.js 22+ (`nvm use`)

### 1. Push to GitHub

```bash
cd prediction-market-divergence
git add .
git commit -m "Add Cloudflare Pages cloud deployment"
git remote add origin https://github.com/YOUR_USER/prediction-market-divergence.git
git push -u origin main
```

### 2. Create D1 database

```bash
npm install
npx wrangler d1 create prediction-market-divergence
```

Copy the `database_id` into `wrangler.toml` (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`), then:

```bash
npm run db:remote
```

### 3. Create Cloudflare Pages project

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Select this repo
3. Build settings:
   - **Framework preset:** None
   - **Build command:** (empty)
   - **Build output directory:** `public`
4. **Settings → Functions** → compatibility date `2026-06-10` (match `wrangler.toml`)

### 4. Bind D1 + environment variables

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

### 5. GitHub Actions secrets

Repo → **Settings → Secrets and variables → Actions**:

| Secret | Where to get it |
|--------|-----------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Edit Cloudflare Workers template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard URL or Workers overview |

Token needs **Cloudflare Pages Edit** + **D1 Edit**.

### 6. Enable Cron Trigger

After first deploy, confirm **Workers & Pages → your project → Settings → Cron Triggers** shows `*/5 * * * *`.

If missing, redeploy with `wrangler.toml` `[triggers]` section (already in repo).

### 7. Deploy

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
# Health — check last_poll_at updates every ~5 minutes
curl -s https://prediction-market-divergence.pages.dev/health | jq

# Manual poll (if POLL_SECRET set, add header)
curl -s -X POST https://prediction-market-divergence.pages.dev/poll | jq

# Opportunities
curl -s "https://prediction-market-divergence.pages.dev/opportunities?min_score=70" | jq
```

**Healthy signals:**

- `last_poll_at` advances every 5 minutes
- `sources.mode` is `live` (or `mock` if configured)
- `sources.runtime` is `cloudflare-pages`
- `status` is `ok` (or `degraded` if last poll errored — check logs)

---

## Logs, monitoring, rollback

### Logs

Cloudflare Dashboard → **Workers & Pages** → your project → **Logs** (Real-time Logs or Logpush).

Filter for scheduled invocations (`_scheduled`) and HTTP errors.

### Update

```bash
git push origin main   # auto-deploy
```

### Rollback

Cloudflare Dashboard → **Deployments** → select previous deployment → **Rollback to this deployment**.

Or redeploy an older git tag:

```bash
git checkout <good-commit>
npm run deploy
git checkout main
```

---

## Remove local launchd service

Once cloud is verified, stop the Mac background service:

```bash
./scripts/uninstall-local-service.sh
```

You no longer need launchd for production. Keep it only if you want a local mirror while developing.

---

## Local development

### Cloud stack (recommended — matches production)

```bash
npm install
npm run db:local
cp .dev.vars.example .dev.vars   # USE_MOCK=true for local demo
npm run dev
```

Open http://localhost:8788

```bash
npm run health:local
npm run poll:local
```

### Legacy Python stack (unit tests / optional local server)

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python run.py              # long-running FastAPI on :8080
python run.py --poll-once  # one-shot
pytest -v
```

`python run.py` is **not required** for production after cloud migration.

---

## API endpoints (same paths locally and in cloud)

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

Point twitter-bot at the **public** cloud URL (not localhost):

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
| Cloudflare Workers (Functions) | 100k requests/day | Cron 288/day + API traffic |
| Cloudflare D1 | 5M rows read/day, 100k writes/day | ~6 markets/poll × 288 ≈ 1.7k obs/day |
| GitHub Actions | 2000 min/month (private) | Deploy-only (~1 min/deploy) |

Cron + D1 should stay **$0/month** at this scale. Upgrade only if traffic or storage grows substantially.

---

## Repo layout

```
prediction_market_engine/   # Python engine (local/tests)
src/                        # TypeScript cloud engine (production)
functions/
  [[path]].ts               # Pages API handler
  _scheduled.ts             # Cron poll handler
public/                     # Dashboard static files
migrations/                 # D1 schema
wrangler.toml               # Cloudflare config
.github/workflows/deploy.yml
scripts/
  deploy.sh
  uninstall-local-service.sh
```

## Future extensions

- Fuzzy cross-venue market matching (live data currently sparse)
- WebSocket push to twitter-bot
- Additional venues
- Sync Python integration tests against cloud API