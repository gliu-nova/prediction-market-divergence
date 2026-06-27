import { Hono } from "hono";
import { cors } from "hono/cors";
import { loadConfig } from "./config";
import { runPoll } from "./poll";
import { kalshiAuthStatus } from "./sources/kalshi";
import {
  ensureTables,
  getHealth,
  getOpportunities,
  getSignalById,
  getSignals,
} from "./storage";
import type { Env, Opportunity } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: "*" }));
app.use("*", async (c, next) => {
  await ensureTables(c.env.DB);
  await next();
});

function opportunityPayload(opp: Opportunity) {
  return { ...opp, detected_at: opp.detected_at };
}

app.get("/health", async (c) =>
  c.json(
    await getHealth(
      c.env.DB,
      loadConfig(c.env),
      c.env.ENVIRONMENT ?? "production",
      await kalshiAuthStatus(c.env),
    ),
  ),
);
app.get("/status", async (c) =>
  c.json(
    await getHealth(
      c.env.DB,
      loadConfig(c.env),
      c.env.ENVIRONMENT ?? "production",
      await kalshiAuthStatus(c.env),
    ),
  ),
);

app.get("/markets", async (c) => {
  const health = await getHealth(c.env.DB, loadConfig(c.env));
  return c.json({
    markets_tracked: health.markets_tracked,
    last_poll_at: health.last_poll_at,
    active_opportunities: health.active_opportunities,
    sources: health.sources,
  });
});

app.get("/signals/latest", async (c) => {
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "10", 10)));
  const signals = await getSignals(c.env.DB, { limit, activeOnly: true });
  return c.json({ signals, count: signals.length });
});

app.get("/signals", async (c) => {
  const minScore = parseInt(c.req.query("min_score") ?? "0", 10);
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query("limit") ?? "50", 10)));
  const signals = await getSignals(c.env.DB, { minScore, limit, activeOnly: false });
  return c.json({ signals, count: signals.length });
});

app.get("/signals/:id", async (c) => {
  const signal = await getSignalById(c.env.DB, c.req.param("id"));
  if (!signal) return c.json({ detail: "Signal not found" }, 404);
  return c.json(signal);
});

app.get("/opportunities", async (c) => {
  const opps = await getOpportunities(c.env.DB, {
    minScore: parseInt(c.req.query("min_score") ?? "0", 10),
    minDifferencePctPoints: parseFloat(c.req.query("min_difference_pct_points") ?? "0"),
    minVolume: parseFloat(c.req.query("min_volume") ?? "0"),
    venue: c.req.query("venue") ?? undefined,
    topic: c.req.query("topic") ?? undefined,
    limit: Math.min(200, Math.max(1, parseInt(c.req.query("limit") ?? "50", 10))),
  });
  return c.json({
    opportunities: opps.map(opportunityPayload),
    count: opps.length,
  });
});

app.get("/opportunities/:id", async (c) => {
  const signal = await getSignalById(c.env.DB, c.req.param("id"));
  if (!signal) return c.json({ detail: "Opportunity not found" }, 404);
  const opp: Opportunity = {
    ...signal,
    detected_at: signal.created_at,
    min_volume: Math.min(signal.market_a.volume ?? 0, signal.market_b?.volume ?? 0),
  };
  return c.json(opportunityPayload(opp));
});

app.post("/poll", async (c) => {
  const secret = c.env.POLL_SECRET;
  if (secret) {
    const auth = c.req.header("Authorization") ?? "";
    if (auth !== `Bearer ${secret}`) return c.json({ detail: "Unauthorized" }, 401);
  }
  try {
    const result = await runPoll(c.env);
    return c.json({ opportunities_found: result.opportunities, status: "ok", ...result });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return c.json({ status: "error", detail }, 500);
  }
});

export default app;