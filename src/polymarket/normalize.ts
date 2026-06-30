import type { GammaMarketRow } from "./discovery.ts";
import type { ClobPriceQuote } from "./clob-rest.ts";
import type { Event, Market, OutcomeToken, PriceSnapshot } from "./types.ts";

function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function toNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function tagLabels(raw: GammaMarketRow): string[] {
  const tags = parseJsonArray<{ label?: string; slug?: string }>(raw.tags);
  return tags.map((tag) => tag.label ?? tag.slug ?? "").filter(Boolean);
}

export function normalizeGammaEvent(raw: Record<string, unknown>): Event {
  return {
    id: String(raw.id ?? ""),
    slug: (raw.slug as string | undefined) ?? null,
    title: (raw.title as string | undefined) ?? null,
    description: (raw.description as string | undefined) ?? null,
    category: (raw.category as string | undefined) ?? null,
    tags: parseJsonArray<{ label?: string }>(raw.tags).map((t) => t.label ?? "").filter(Boolean),
    active: (raw.active as boolean | undefined) ?? null,
    closed: (raw.closed as boolean | undefined) ?? null,
    startDate: (raw.startDate as string | undefined) ?? null,
    endDate: (raw.endDate as string | undefined) ?? null,
    volume: toNumber(raw.volume),
    liquidity: toNumber(raw.liquidity),
    sourceUpdatedAt: (raw.updatedAt as string | undefined) ?? null,
  };
}

export function normalizeGammaMarket(raw: GammaMarketRow): Market | null {
  const id = String(raw.id ?? "");
  const question = String(raw.question ?? raw.title ?? "");
  if (!id || !question) return null;

  const outcomes = parseJsonArray<string>(raw.outcomes);
  const outcomePrices = parseJsonArray<string>(raw.outcomePrices).map((p) => Number(p));
  const events = parseJsonArray<Record<string, unknown>>(raw.events);
  const eventId = events[0]?.id ? String(events[0].id) : null;
  const slug = (raw.slug as string | undefined) ?? id;

  return {
    id,
    eventId,
    slug,
    conditionId: (raw.conditionId as string | undefined) ?? null,
    question,
    description: (raw.description as string | undefined) ?? null,
    category: (raw.category as string | undefined) ?? null,
    tags: tagLabels(raw),
    active: Boolean(raw.active),
    closed: Boolean(raw.closed),
    resolved: Boolean(raw.closed) && Boolean(raw.automaticallyResolved),
    startDate: (raw.startDate as string | undefined) ?? (raw.startDateIso as string | undefined) ?? null,
    endDate: (raw.endDate as string | undefined) ?? (raw.endDateIso as string | undefined) ?? null,
    volume: toNumber(raw.volumeNum ?? raw.volume),
    liquidity: toNumber(raw.liquidityNum ?? raw.liquidity),
    outcomes,
    outcomePrices,
    enableOrderBook: Boolean(raw.enableOrderBook),
    bestBid: toNumber(raw.bestBid),
    bestAsk: toNumber(raw.bestAsk),
    lastTradePrice: toNumber(raw.lastTradePrice),
    sourceUpdatedAt: (raw.updatedAt as string | undefined) ?? null,
    url: `https://polymarket.com/event/${slug}`,
  };
}

export function extractOutcomeTokens(market: Market, raw: GammaMarketRow): OutcomeToken[] {
  const tokenIds = parseJsonArray<string>(raw.clobTokenIds);
  const outcomes = market.outcomes.length ? market.outcomes : tokenIds.map((_, i) => `Outcome ${i + 1}`);
  return tokenIds.map((tokenId, outcomeIndex) => ({
    marketId: market.id,
    outcomeIndex,
    outcomeLabel: outcomes[outcomeIndex] ?? `Outcome ${outcomeIndex + 1}`,
    tokenId,
  }));
}

export function primaryYesToken(tokens: OutcomeToken[]): OutcomeToken | null {
  const yes = tokens.find((t) => t.outcomeLabel.toLowerCase() === "yes");
  return yes ?? tokens[0] ?? null;
}

export function buildGammaPriceSnapshot(market: Market, token: OutcomeToken, ingestedAt: string): PriceSnapshot {
  const bestBid = market.bestBid;
  const bestAsk = market.bestAsk;
  const lastTradePrice = market.lastTradePrice;
  const sourceTimestamp = market.sourceUpdatedAt;
  return {
    marketId: market.id,
    tokenId: token.tokenId,
    bestBid,
    bestAsk,
    mid: bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null,
    spread: bestBid != null && bestAsk != null ? Math.max(0, bestAsk - bestBid) : null,
    lastTradePrice,
    source: "gamma",
    sourceTimestamp,
    ingestedAt,
    staleAgeMs: computeStaleAgeMs(sourceTimestamp, ingestedAt),
  };
}

export function buildClobPriceSnapshot(
  marketId: string,
  quote: ClobPriceQuote,
  ingestedAt: string,
): PriceSnapshot {
  const spread =
    quote.bestBid != null && quote.bestAsk != null ? Math.max(0, quote.bestAsk - quote.bestBid) : null;
  return {
    marketId,
    tokenId: quote.tokenId,
    bestBid: quote.bestBid,
    bestAsk: quote.bestAsk,
    mid: quote.mid,
    spread,
    lastTradePrice: quote.lastTradePrice,
    source: "clob",
    sourceTimestamp: quote.sourceTimestamp,
    ingestedAt,
    staleAgeMs: computeStaleAgeMs(quote.sourceTimestamp, ingestedAt),
  };
}

export function computeStaleAgeMs(sourceTimestamp: string | null, ingestedAt: string): number | null {
  if (!sourceTimestamp) return null;
  const sourceMs = new Date(sourceTimestamp).getTime();
  const ingestedMs = new Date(ingestedAt).getTime();
  if (Number.isNaN(sourceMs) || Number.isNaN(ingestedMs)) return null;
  return Math.max(0, ingestedMs - sourceMs);
}

export function isStale(snapshot: PriceSnapshot, thresholdMs: number): boolean {
  return snapshot.staleAgeMs != null && snapshot.staleAgeMs > thresholdMs;
}

export function toLegacyRawMarket(
  market: Market,
  token: OutcomeToken,
  snapshot: PriceSnapshot,
  fetchedAt: string,
): Record<string, unknown> {
  const probability =
    snapshot.mid ??
    (snapshot.bestBid != null && snapshot.bestAsk != null
      ? (snapshot.bestBid + snapshot.bestAsk) / 2
      : snapshot.lastTradePrice ?? market.outcomePrices[token.outcomeIndex] ?? null);

  return {
    id: market.id,
    condition_id: market.conditionId,
    slug: market.slug,
    question: market.question,
    description: market.description,
    category: market.category,
    tags: market.tags,
    active: market.active,
    closed: market.closed,
    volumeNum: market.volume,
    liquidityNum: market.liquidity,
    outcomePrices: JSON.stringify(market.outcomePrices),
    outcomes: JSON.stringify(market.outcomes),
    clobTokenIds: JSON.stringify([token.tokenId]),
    bestBid: snapshot.bestBid,
    bestAsk: snapshot.bestAsk,
    lastTradePrice: snapshot.lastTradePrice ?? probability,
    yes_price: probability,
    url: market.url,
    venue: "polymarket",
    fetched_at: fetchedAt,
    source_timestamp: snapshot.sourceTimestamp,
    stale_age_ms: snapshot.staleAgeMs,
    price_source: snapshot.source,
  };
}

