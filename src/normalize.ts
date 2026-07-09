import type { CanonicalMarket, MarketObservation } from "./types";
import { buildKalshiMarketUrl, buildPolymarketMarketUrl } from "./market-urls.ts";

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

/** Low-signal tokens stripped when building match keys. */
const MATCH_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "will",
  "be",
  "is",
  "are",
  "in",
  "on",
  "at",
  "by",
  "of",
  "to",
  "for",
  "and",
  "or",
  "vs",
  "versus",
  "above",
  "below",
  "over",
  "under",
  "exceed",
  "exceeds",
  "reach",
  "reaches",
  "hit",
  "hits",
  "end",
  "ending",
  "meeting",
  "odds",
  "before",
  "after",
  "during",
  "between",
  "from",
  "into",
  "with",
  "without",
  "than",
  "then",
  "this",
  "that",
  "year",
  "years",
  "month",
  "months",
]);

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Normalize currency / compact number tokens so 100k and 100,000 align. */
function normalizeNumberToken(token: string): string {
  const lower = token.toLowerCase();
  const compact = lower.match(/^(\d+(?:\.\d+)?)([kmb])$/);
  if (compact) {
    const n = Number(compact[1]);
    const mult = compact[2] === "k" ? 1_000 : compact[2] === "m" ? 1_000_000 : 1_000_000_000;
    return String(Math.round(n * mult));
  }
  if (/^\d+$/.test(lower)) return lower.replace(/^0+/, "") || "0";
  return lower;
}

/** Light stemming so cut/cuts and rate/rates share a token. */
function stemToken(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("sses")) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us")) return token.slice(0, -1);
  return token;
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
  if (venue === "kalshi") return buildKalshiMarketUrl(raw);
  if (venue === "polymarket") return buildPolymarketMarketUrl(raw, marketId);
  if (raw.url) return String(raw.url);
  return "";
}

/**
 * Build a cross-venue match key from title + topic.
 * Uses significant stemmed tokens (not raw slug equality) so minor wording
 * differences between Kalshi and Polymarket titles can still pair.
 */
export function buildMatchKey(title: string, topic: string): string {
  const topicSlug = slugify(topic);
  const tokens = slugify(title)
    .split("-")
    .map(normalizeNumberToken)
    .map(stemToken)
    .filter((t) => t && !MATCH_STOPWORDS.has(t) && !MATCH_STOPWORDS.has(stemToken(t)));
  const unique = [...new Set(tokens)].sort();
  const titleKey = unique.join("-") || slugify(title);
  return `${topicSlug}:${titleKey}`;
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
