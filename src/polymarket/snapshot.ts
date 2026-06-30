import type { PolymarketIngestConfig } from "./config.ts";
import { discoverMarkets } from "./discovery.ts";
import { enrichTokenPrices, fetchOrderBook } from "./clob-rest.ts";
import { fetchRecentTrades } from "./data-api.ts";
import { RateLimitedClient, type FetchLike, type Logger, consoleLogger } from "./http.ts";
import {
  buildClobPriceSnapshot,
  buildGammaPriceSnapshot,
  extractOutcomeTokens,
  normalizeGammaEvent,
  normalizeGammaMarket,
  primaryYesToken,
  toLegacyRawMarket,
} from "./normalize.ts";
import type { IngestionRun, PolymarketSnapshotResult } from "./types.ts";

export interface SnapshotOptions {
  activeOnly?: boolean;
  limit?: number;
  maxMarkets?: number;
  includeOrderBooks?: boolean;
  includeTrades?: boolean;
  tradeSince?: string;
  mode?: IngestionRun["mode"];
  fetchFn?: FetchLike;
  logger?: Logger;
}

function newRunId(): string {
  return `poly-${Date.now()}`;
}

export async function runPolymarketSnapshot(
  config: PolymarketIngestConfig,
  opts: SnapshotOptions = {},
): Promise<PolymarketSnapshotResult> {
  const logger = opts.logger ?? consoleLogger;
  const client = new RateLimitedClient(config, opts.fetchFn, logger);
  const startedAt = new Date().toISOString();
  const run: IngestionRun = {
    id: newRunId(),
    mode: opts.mode ?? "snapshot",
    startedAt,
    finishedAt: null,
    status: "running",
    marketsDiscovered: 0,
    marketsEnriched: 0,
    snapshotsStored: 0,
    orderBooksStored: 0,
    tradesStored: 0,
    error: null,
  };

  try {
    const discovery = await discoverMarkets(config, client, {
      activeOnly: opts.activeOnly ?? true,
      limit: opts.limit,
      maxMarkets: opts.maxMarkets,
    });

    const ingestedAt = new Date().toISOString();
    const events = [];
    const markets = [];
    const tokens = [];
    const priceSnapshots = [];
    const orderBooks = [];
    const trades = [];
    const legacyRawMarkets = [];

    const yesTokenIds: Array<{ marketId: string; tokenId: string }> = [];

    for (const raw of discovery.markets) {
      const market = normalizeGammaMarket(raw);
      if (!market) continue;
      markets.push(market);

      for (const eventRaw of Array.isArray(raw.events) ? raw.events : []) {
        if (eventRaw && typeof eventRaw === "object") events.push(normalizeGammaEvent(eventRaw as Record<string, unknown>));
      }

      const marketTokens = extractOutcomeTokens(market, raw);
      tokens.push(...marketTokens);
      const yesToken = primaryYesToken(marketTokens);
      if (!yesToken) continue;

      const gammaSnap = buildGammaPriceSnapshot(market, yesToken, ingestedAt);
      priceSnapshots.push(gammaSnap);
      yesTokenIds.push({ marketId: market.id, tokenId: yesToken.tokenId });
    }

    run.marketsDiscovered = markets.length;

    const enrichLimit = Math.min(config.clobEnrichMaxMarkets, yesTokenIds.length);
    const enrichTargets = yesTokenIds.slice(0, enrichLimit);
    const clobQuotes = await enrichTokenPrices(
      config,
      client,
      enrichTargets.map((t) => t.tokenId),
      {
        includeMidpoint: opts.includeOrderBooks === true,
        includeLastTrade: opts.includeOrderBooks === true && enrichLimit <= 10,
      },
    );
    const quoteByToken = new Map(clobQuotes.map((q) => [q.tokenId, q]));

    for (const target of enrichTargets) {
      const quote = quoteByToken.get(target.tokenId);
      if (!quote) continue;
      const snap = buildClobPriceSnapshot(target.marketId, quote, ingestedAt);
      priceSnapshots.push(snap);
      run.marketsEnriched += 1;

      if (opts.includeOrderBooks) {
        const book = await fetchOrderBook(config, client, target.marketId, target.tokenId, config.orderBookDepth);
        if (book) {
          orderBooks.push(book);
          run.orderBooksStored += 1;
        }
      }
    }

    if (opts.includeTrades) {
      for (const market of markets.slice(0, Math.min(10, markets.length))) {
        const marketTrades = await fetchRecentTrades(config, client, {
          marketId: market.id,
          conditionId: market.conditionId ?? undefined,
          since: opts.tradeSince,
          limit: Math.min(20, config.tradeBackfillLimit),
        });
        trades.push(...marketTrades);
      }
      run.tradesStored = trades.length;
    }

    const latestPriceByMarket = new Map<string, ReturnType<typeof buildClobPriceSnapshot>>();
    for (const snap of priceSnapshots) {
      if (snap.source === "clob") latestPriceByMarket.set(snap.marketId, snap);
    }

    for (const market of markets) {
      const marketTokens = tokens.filter((t) => t.marketId === market.id);
      const yesToken = primaryYesToken(marketTokens);
      if (!yesToken) continue;
      const snap =
        latestPriceByMarket.get(market.id) ??
        priceSnapshots.find((p) => p.marketId === market.id && p.tokenId === yesToken.tokenId);
      if (!snap) continue;
      legacyRawMarkets.push(toLegacyRawMarket(market, yesToken, snap, ingestedAt));
    }

    run.snapshotsStored = priceSnapshots.length;
    run.status = "ok";
    run.finishedAt = new Date().toISOString();

    logger.info("polymarket snapshot complete", {
      runId: run.id,
      markets: markets.length,
      enriched: run.marketsEnriched,
      truncated: discovery.truncated,
    });

    return { run, events, markets, tokens, priceSnapshots, orderBooks, trades, legacyRawMarkets };
  } catch (err) {
    run.status = "error";
    run.error = err instanceof Error ? err.message : String(err);
    run.finishedAt = new Date().toISOString();
    logger.error("polymarket snapshot failed", { error: run.error });
    throw err;
  }
}