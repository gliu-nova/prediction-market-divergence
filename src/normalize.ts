import type { CanonicalMarket, MarketObservation } from "./types";

const TOPIC_KEYWORDS: Record<string, string> = {
  fed: "Fed rates",
  rate: "Fed rates",
  fomc: "Fed rates",
  bitcoin: "Bitcoin",
  btc: "Bitcoin",
  recession: "Macro",
  gdp: "Macro",
  inflation: "Macro",
  cpi: "Macro",
  election: "Politics",
  president: "Politics",
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function inferTopic(title: string, explicit?: string): string {
  if (explicit) return explicit;
  const lower = title.toLowerCase();
  for (const [keyword, topic] of Object.entries(TOPIC_KEYWORDS)) {
    if (lower.includes(keyword)) return topic;
  }
  return "General";
}

function toProbability(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const p = Number(value);
  if (Number.isNaN(p) || p > 100) return null;
  return p > 1 ? p / 100 : p;
}

function extractTitle(raw: Record<string, unknown>, venue: string): string {
  if (venue === "kalshi") {
    return String(raw.title ?? raw.event_title ?? "Unknown");
  }
  return String(raw.question ?? raw.title ?? raw.description ?? "Unknown");
}

function extractMarketId(raw: Record<string, unknown>, venue: string): string {
  if (venue === "kalshi") {
    return String(raw.ticker ?? raw.market_ticker ?? "");
  }
  return String(raw.id ?? raw.condition_id ?? raw.slug ?? "");
}

function extractProbability(raw: Record<string, unknown>, venue: string): number | null {
  if (raw.yes_price != null) {
    const p = toProbability(raw.yes_price);
    if (p != null) return p;
  }

  if (venue === "kalshi") {
    const bid = toProbability(raw.yes_bid_dollars);
    const ask = toProbability(raw.yes_ask_dollars);
    if (bid != null && ask != null && bid > 0 && ask > 0) return (bid + ask) / 2;
    for (const key of ["last_price_dollars", "yes_bid_dollars", "yes_ask_dollars"]) {
      const p = toProbability(raw[key]);
      if (p != null && p > 0) return p;
    }
  }

  if (venue === "polymarket") {
    let outcomes = raw.outcomePrices ?? raw.outcome_prices;
    if (typeof outcomes === "string") {
      try {
        outcomes = JSON.parse(outcomes);
      } catch {
        outcomes = null;
      }
    }
    if (Array.isArray(outcomes) && outcomes.length) {
      const p = toProbability(outcomes[0]);
      if (p != null) return p;
    }
    for (const key of ["lastTradePrice", "bestBid", "bestAsk"]) {
      const p = toProbability(raw[key]);
      if (p != null && p > 0) return p;
    }
  }

  for (const key of ["last_price", "yes_bid", "last_price_dollars"]) {
    const p = toProbability(raw[key]);
    if (p != null && p > 0) return p;
  }
  return null;
}

function extractVolume(raw: Record<string, unknown>): number | null {
  for (const key of [
    "volumeNum",
    "volume",
    "volume_fp",
    "volume_24h_fp",
    "volume_24h",
    "volume24hr",
    "total_volume",
  ]) {
    if (raw[key] != null) {
      const v = Number(raw[key]);
      if (!Number.isNaN(v)) return v;
    }
  }
  return null;
}

function extractLiquidity(raw: Record<string, unknown>): number | null {
  for (const key of ["liquidityNum", "liquidity", "liquidity_dollars", "open_interest", "liquidity_usd"]) {
    if (raw[key] != null) {
      const v = Number(raw[key]);
      if (!Number.isNaN(v)) return v;
    }
  }
  return null;
}

function extractUrl(raw: Record<string, unknown>, venue: string, marketId: string): string {
  if (raw.url) return String(raw.url);
  if (venue === "kalshi") return `https://kalshi.com/markets/${marketId.toLowerCase()}`;
  const slug = String(raw.slug ?? marketId);
  return `https://polymarket.com/event/${slug}`;
}

function buildMatchKey(title: string, topic: string): string {
  let titleSlug = slugify(title);
  const topicSlug = slugify(topic);
  for (const prefix of ["will-the-", "will-", "us-"]) {
    if (titleSlug.startsWith(prefix)) titleSlug = titleSlug.slice(prefix.length);
  }
  return `${topicSlug}:${titleSlug}`;
}

export function normalizeRawMarket(
  raw: Record<string, unknown>,
  observedAt: string,
): CanonicalMarket | null {
  const venueStr = String(raw.venue ?? "").toLowerCase();
  if (venueStr !== "kalshi" && venueStr !== "polymarket") return null;

  const marketId = extractMarketId(raw, venueStr);
  const title = extractTitle(raw, venueStr);
  if (!marketId || !title || title === "Unknown") return null;

  const probability = extractProbability(raw, venueStr);
  if (probability == null || probability < 0 || probability > 1) return null;

  const topic = inferTopic(title, raw.topic as string | undefined);
  const matchKey = String(raw.match_key ?? raw.canonical_id ?? buildMatchKey(title, topic));

  return {
    canonical_id: matchKey,
    title,
    topic,
    venue: venueStr,
    market_id: marketId,
    probability,
    volume: extractVolume(raw),
    liquidity: extractLiquidity(raw),
    url: extractUrl(raw, venueStr, marketId),
    observed_at: String(raw.fetched_at ?? observedAt),
    match_key: matchKey,
  };
}

export function toObservation(market: CanonicalMarket): MarketObservation {
  return {
    venue: market.venue === "kalshi" ? "Kalshi" : "Polymarket",
    market_id: market.market_id,
    canonical_id: market.canonical_id,
    title: market.title,
    topic: market.topic,
    probability: market.probability,
    volume: market.volume,
    liquidity: market.liquidity,
    url: market.url,
    observed_at: market.observed_at,
  };
}