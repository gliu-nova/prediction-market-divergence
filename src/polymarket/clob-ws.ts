import type { PolymarketIngestConfig } from "./config.ts";
import type { OrderBookSnapshot, PriceSnapshot, Trade } from "./types.ts";
import { consoleLogger, type Logger } from "./http.ts";

export interface StreamEvent {
  type: "book" | "price_change" | "last_trade_price" | "best_bid_ask" | "other";
  tokenId: string | null;
  marketId: string | null;
  priceSnapshot?: PriceSnapshot;
  orderBook?: OrderBookSnapshot;
  trade?: Trade;
  raw: Record<string, unknown>;
}

export interface StreamOptions {
  tokenIds: string[];
  durationMs?: number;
  onEvent?: (event: StreamEvent) => void;
  logger?: Logger;
}

function parseWsMessage(payload: Record<string, unknown>, ingestedAt: string): StreamEvent {
  const eventType = String(payload.event_type ?? "other");
  const tokenId = (payload.asset_id as string | undefined) ?? null;
  const marketId = (payload.market as string | undefined) ?? null;

  if (eventType === "book") {
    const bids = Array.isArray(payload.bids)
      ? payload.bids.map((level, index) => ({
          side: "bid" as const,
          price: Number((level as { price: string }).price),
          size: Number((level as { size: string }).size),
          level: index,
        }))
      : [];
    const asks = Array.isArray(payload.asks)
      ? payload.asks.map((level, index) => ({
          side: "ask" as const,
          price: Number((level as { price: string }).price),
          size: Number((level as { size: string }).size),
          level: index,
        }))
      : [];
    return {
      type: "book",
      tokenId,
      marketId,
      orderBook: {
        marketId: marketId ?? "",
        tokenId: tokenId ?? "",
        bids,
        asks,
        lastTradePrice: null,
        sourceTimestamp: payload.timestamp ? new Date(Number(payload.timestamp)).toISOString() : ingestedAt,
        ingestedAt,
      },
      raw: payload,
    };
  }

  if (eventType === "last_trade_price") {
    return {
      type: "last_trade_price",
      tokenId,
      marketId,
      trade: {
        id: `${tokenId}-${payload.timestamp ?? Date.now()}`,
        marketId,
        conditionId: marketId,
        tokenId,
        side: (payload.side as string | undefined) ?? null,
        price: Number(payload.price ?? 0),
        size: Number(payload.size ?? 0),
        outcome: null,
        traderName: null,
        transactionHash: null,
        tradedAt: payload.timestamp ? new Date(Number(payload.timestamp)).toISOString() : ingestedAt,
        ingestedAt,
        source: "ws",
      },
      raw: payload,
    };
  }

  if (eventType === "best_bid_ask") {
    const bestBid = Number(payload.best_bid ?? 0);
    const bestAsk = Number(payload.best_ask ?? 0);
    return {
      type: "best_bid_ask",
      tokenId,
      marketId,
      priceSnapshot: {
        marketId: marketId ?? "",
        tokenId: tokenId ?? "",
        bestBid,
        bestAsk,
        mid: (bestBid + bestAsk) / 2,
        spread: Math.max(0, bestAsk - bestBid),
        lastTradePrice: null,
        source: "ws",
        sourceTimestamp: payload.timestamp ? new Date(Number(payload.timestamp)).toISOString() : ingestedAt,
        ingestedAt,
        staleAgeMs: 0,
      },
      raw: payload,
    };
  }

  return { type: eventType === "price_change" ? "price_change" : "other", tokenId, marketId, raw: payload };
}

export async function streamPolymarketMarketChannel(
  config: PolymarketIngestConfig,
  opts: StreamOptions,
): Promise<StreamEvent[]> {
  const logger = opts.logger ?? consoleLogger;
  const events: StreamEvent[] = [];
  const durationMs = opts.durationMs ?? 10_000;

  let WebSocketImpl: typeof import("ws").WebSocket;
  try {
    ({ WebSocket: WebSocketImpl } = await import("ws"));
  } catch {
    throw new Error("WebSocket streaming requires the ws package. Run: npm install");
  }

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocketImpl(config.endpoints.clobWsUrl);
    const timer = setTimeout(() => {
      ws.close();
      resolve();
    }, durationMs);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          assets_ids: opts.tokenIds,
          type: "market",
          custom_feature_enabled: true,
        }),
      );
      logger.info("polymarket ws subscribed", { tokens: opts.tokenIds.length });
    });

    ws.on("message", (data) => {
      try {
        const payload = JSON.parse(String(data)) as Record<string, unknown>;
        const ingestedAt = new Date().toISOString();
        const parsed = parseWsMessage(payload, ingestedAt);
        events.push(parsed);
        opts.onEvent?.(parsed);
      } catch (err) {
        logger.warn("polymarket ws parse error", { error: String(err) });
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    ws.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  return events;
}