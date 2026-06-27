export const KALSHI_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
export const KALSHI_MARKETS_PAGE_LIMIT = 1000;
/** Stay under Cloudflare Workers free-tier external subrequest limit (50), leaving room for Polymarket. */
export const KALSHI_MAX_PAGES = 25;
export const KALSHI_PAGE_THROTTLE_MS = 750;
export const KALSHI_MAX_RETRIES = 6;
export const KALSHI_RETRY_BASE_MS = 1000;

export interface KalshiMarketsApiResponse {
  markets?: Record<string, unknown>[];
  cursor?: string | null;
}

export interface KalshiMarketsPageResult {
  markets: Record<string, unknown>[];
  cursor: string | null;
  raw: KalshiMarketsApiResponse;
}

export interface KalshiIngestPage {
  pageIndex: number;
  requestCursor: string | null;
  responseCursor: string | null;
  marketCount: number;
  payload: KalshiMarketsApiResponse;
}

export interface KalshiIngestResult {
  pages: KalshiIngestPage[];
  markets: Record<string, unknown>[];
}

export type FetchLike = typeof fetch;

export interface KalshiFetchOptions {
  fetchFn?: FetchLike;
  pageThrottleMs?: number;
  maxRetries?: number;
  maxPages?: number;
}

export function isMveParlayMarket(raw: Record<string, unknown>): boolean {
  const ticker = String(raw.ticker ?? raw.market_ticker ?? "").toUpperCase();
  if (ticker.startsWith("KXMV")) return true;

  const eventTicker = String(raw.event_ticker ?? "").toUpperCase();
  if (eventTicker.startsWith("KXMV")) return true;

  if (raw.mve_collection_ticker) return true;
  if (Array.isArray(raw.mve_selected_legs) && raw.mve_selected_legs.length > 0) return true;

  return false;
}

export function filterMveParlayMarkets(markets: Record<string, unknown>[]): Record<string, unknown>[] {
  return markets.filter((market) => !isMveParlayMarket(market));
}

export function parseKalshiMarketsPage(data: KalshiMarketsApiResponse | Record<string, unknown>[]): KalshiMarketsPageResult {
  if (Array.isArray(data)) {
    const markets = filterMveParlayMarkets(data);
    return { markets, cursor: null, raw: { markets: data, cursor: null } };
  }

  const rawMarkets = data.markets ?? [];
  const markets = filterMveParlayMarkets(rawMarkets);
  const cursorValue = data.cursor;
  const cursor = typeof cursorValue === "string" && cursorValue.trim() ? cursorValue.trim() : null;
  return { markets, cursor, raw: data };
}

export function buildKalshiMarketsUrl(cursor: string | null): string {
  const params = new URLSearchParams({
    limit: String(KALSHI_MARKETS_PAGE_LIMIT),
    status: "open",
    mve_filter: "exclude",
  });
  if (cursor) params.set("cursor", cursor);
  return `${KALSHI_BASE_URL}/markets?${params}`;
}

function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
  }
  const base = KALSHI_RETRY_BASE_MS * 2 ** attempt;
  return base + Math.floor(Math.random() * base * 0.25);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchKalshiMarketsPage(
  cursor: string | null,
  options: KalshiFetchOptions = {},
): Promise<KalshiMarketsPageResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const maxRetries = options.maxRetries ?? KALSHI_MAX_RETRIES;
  const url = buildKalshiMarketsUrl(cursor);

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const resp = await fetchFn(url, {
      headers: { Accept: "application/json" },
    });

    if (resp.status === 429 && attempt < maxRetries - 1) {
      await sleep(retryDelayMs(attempt, resp.headers.get("Retry-After")));
      continue;
    }

    if (!resp.ok) throw new Error(`Kalshi fetch failed: ${resp.status}`);
    const data = (await resp.json()) as KalshiMarketsApiResponse | Record<string, unknown>[];
    return parseKalshiMarketsPage(data);
  }

  throw new Error("Kalshi fetch failed: 429");
}

export async function fetchKalshiMarketsPages(options: KalshiFetchOptions = {}): Promise<KalshiIngestPage[]> {
  const pageThrottleMs = options.pageThrottleMs ?? KALSHI_PAGE_THROTTLE_MS;
  const maxPages = options.maxPages ?? KALSHI_MAX_PAGES;
  const pages: KalshiIngestPage[] = [];
  let requestCursor: string | null = null;
  let pageIndex = 0;

  while (true) {
    const page = await fetchKalshiMarketsPage(requestCursor, options);
    pages.push({
      pageIndex,
      requestCursor,
      responseCursor: page.cursor,
      marketCount: page.markets.length,
      payload: page.raw,
    });
    if (!page.cursor || pages.length >= maxPages) break;
    requestCursor = page.cursor;
    pageIndex += 1;
    if (pageThrottleMs > 0) await sleep(pageThrottleMs);
  }

  return pages;
}

export async function fetchKalshiMarkets(
  fetchedAt: string,
  options: KalshiFetchOptions = {},
): Promise<KalshiIngestResult> {
  const pages = await fetchKalshiMarketsPages(options);
  const markets: Record<string, unknown>[] = [];

  for (const page of pages) {
    const pageResult = parseKalshiMarketsPage(page.payload);
    for (const row of pageResult.markets) {
      markets.push({ ...row, venue: "kalshi", fetched_at: fetchedAt });
    }
  }

  return { pages, markets };
}

export async function kalshiHealthy(fetchFn: FetchLike = fetch): Promise<boolean> {
  try {
    const resp = await fetchFn(`${KALSHI_BASE_URL}/markets?limit=1&mve_filter=exclude`);
    return resp.ok;
  } catch {
    return false;
  }
}