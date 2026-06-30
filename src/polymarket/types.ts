export interface Event {
  id: string;
  slug: string | null;
  title: string | null;
  description: string | null;
  category: string | null;
  tags: string[];
  active: boolean | null;
  closed: boolean | null;
  startDate: string | null;
  endDate: string | null;
  volume: number | null;
  liquidity: number | null;
  sourceUpdatedAt: string | null;
}

export interface Market {
  id: string;
  eventId: string | null;
  slug: string | null;
  conditionId: string | null;
  question: string;
  description: string | null;
  category: string | null;
  tags: string[];
  active: boolean;
  closed: boolean;
  resolved: boolean;
  startDate: string | null;
  endDate: string | null;
  volume: number | null;
  liquidity: number | null;
  outcomes: string[];
  outcomePrices: number[];
  enableOrderBook: boolean;
  bestBid: number | null;
  bestAsk: number | null;
  lastTradePrice: number | null;
  sourceUpdatedAt: string | null;
  url: string;
}

export interface OutcomeToken {
  marketId: string;
  outcomeIndex: number;
  outcomeLabel: string;
  tokenId: string;
}

export interface PriceSnapshot {
  marketId: string;
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  lastTradePrice: number | null;
  source: "gamma" | "clob" | "ws";
  sourceTimestamp: string | null;
  ingestedAt: string;
  staleAgeMs: number | null;
}

export interface OrderBookLevel {
  side: "bid" | "ask";
  price: number;
  size: number;
  level: number;
}

export interface OrderBookSnapshot {
  marketId: string;
  tokenId: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  lastTradePrice: number | null;
  sourceTimestamp: string | null;
  ingestedAt: string;
}

export interface Trade {
  id: string;
  marketId: string | null;
  conditionId: string | null;
  tokenId: string | null;
  side: string | null;
  price: number;
  size: number;
  outcome: string | null;
  traderName: string | null;
  transactionHash: string | null;
  tradedAt: string;
  ingestedAt: string;
  source: "data-api" | "ws" | "polygon";
}

export interface IngestionRun {
  id: string;
  mode: "discover" | "snapshot" | "stream" | "backfill-trades" | "poll";
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "error";
  marketsDiscovered: number;
  marketsEnriched: number;
  snapshotsStored: number;
  orderBooksStored: number;
  tradesStored: number;
  error: string | null;
}

export interface OpportunityCandidate {
  marketId: string;
  title: string;
  probability: number;
  spread: number | null;
  volume: number | null;
  staleAgeMs: number | null;
  reason: string;
}

export interface PolymarketSnapshotResult {
  run: IngestionRun;
  events: Event[];
  markets: Market[];
  tokens: OutcomeToken[];
  priceSnapshots: PriceSnapshot[];
  orderBooks: OrderBookSnapshot[];
  trades: Trade[];
  legacyRawMarkets: Record<string, unknown>[];
}