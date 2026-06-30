import type { PolymarketIngestConfig } from "./config.ts";
import { RateLimitedClient } from "./http.ts";

export interface GammaMarketRow extends Record<string, unknown> {
  id?: string;
  question?: string;
  slug?: string;
  conditionId?: string;
  active?: boolean;
  closed?: boolean;
}

export interface GammaEventRow extends Record<string, unknown> {
  id?: string;
  slug?: string;
  title?: string;
}

export interface DiscoverMarketsOptions {
  activeOnly?: boolean;
  limit?: number;
  maxMarkets?: number;
  maxPages?: number;
}

export interface DiscoverMarketsResult {
  markets: GammaMarketRow[];
  pagesFetched: number;
  truncated: boolean;
}

function buildMarketsUrl(config: PolymarketIngestConfig, opts: DiscoverMarketsOptions, offset: number): string {
  const params = new URLSearchParams({
    limit: String(opts.limit ?? config.discoveryPageSize),
    offset: String(offset),
    order: "volumeNum",
    ascending: "false",
  });
  if (opts.activeOnly ?? true) params.set("active", "true");
  else params.set("closed", "false");
  return `${config.endpoints.gammaBaseUrl}/markets?${params}`;
}

export async function discoverMarkets(
  config: PolymarketIngestConfig,
  client: RateLimitedClient,
  opts: DiscoverMarketsOptions = {},
): Promise<DiscoverMarketsResult> {
  const maxMarkets = opts.maxMarkets ?? config.discoveryMaxMarkets;
  const maxPages = opts.maxPages ?? config.maxGammaPages;
  const pageSize = opts.limit ?? config.discoveryPageSize;
  const markets: GammaMarketRow[] = [];
  let offset = 0;
  let pagesFetched = 0;
  let truncated = false;

  while (pagesFetched < maxPages && markets.length < maxMarkets) {
    const url = buildMarketsUrl(config, { ...opts, limit: pageSize }, offset);
    const page = await client.fetchJson<GammaMarketRow[]>(url);
    if (!Array.isArray(page) || page.length === 0) break;

    for (const row of page) {
      markets.push(row);
      if (markets.length >= maxMarkets) {
        truncated = true;
        break;
      }
    }

    pagesFetched += 1;
    if (page.length < pageSize) break;
    offset += pageSize;
    if (markets.length >= maxMarkets) {
      truncated = true;
      break;
    }
    if (pagesFetched >= maxPages) truncated = true;
  }

  return { markets, pagesFetched, truncated };
}

export async function discoverEvents(
  config: PolymarketIngestConfig,
  client: RateLimitedClient,
  opts: { limit?: number; activeOnly?: boolean } = {},
): Promise<GammaEventRow[]> {
  const params = new URLSearchParams({
    limit: String(opts.limit ?? config.discoveryPageSize),
    order: "volume",
    ascending: "false",
  });
  if (opts.activeOnly ?? true) params.set("active", "true");
  const url = `${config.endpoints.gammaBaseUrl}/events?${params}`;
  const rows = await client.fetchJson<GammaEventRow[]>(url);
  return Array.isArray(rows) ? rows : [];
}

export async function fetchMarketBySlugOrId(
  config: PolymarketIngestConfig,
  client: RateLimitedClient,
  slugOrId: string,
): Promise<GammaMarketRow | null> {
  const isNumeric = /^\d+$/.test(slugOrId);
  const params = new URLSearchParams(isNumeric ? { id: slugOrId } : { slug: slugOrId });
  const url = `${config.endpoints.gammaBaseUrl}/markets?${params}`;
  const rows = await client.fetchJson<GammaMarketRow[]>(url);
  return Array.isArray(rows) && rows.length ? rows[0]! : null;
}