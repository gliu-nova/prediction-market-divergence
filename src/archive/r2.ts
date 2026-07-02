import type { PolymarketSnapshotResult } from "../polymarket/types.ts";
import type { CanonicalMarket, MatchedPair } from "../types.ts";

export type ArchiveSource = "polymarket" | "kalshi";

function partitionFromTs(ts: string): { day: string; hour: string } {
  return { day: ts.slice(0, 10), hour: ts.slice(11, 13) };
}

function marketsKey(source: ArchiveSource, ts: string): string {
  const { day, hour } = partitionFromTs(ts);
  return `${source}/markets/${day}/${hour}.jsonl.gz`;
}

function orderbookKey(marketId: string, ts: string): string {
  const { day } = partitionFromTs(ts);
  const safeId = marketId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  return `polymarket/orderbooks/by-market/${day}/${safeId}.jsonl.gz`;
}

function orderbooksBatchKey(ts: string): string {
  const { day, hour } = partitionFromTs(ts);
  return `polymarket/orderbooks/${day}/${hour}.jsonl.gz`;
}

async function gzipText(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function gunzipText(data: ArrayBuffer): Promise<string> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

export async function appendJsonlGz(bucket: R2Bucket, key: string, record: unknown): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  const existing = await bucket.get(key);
  let body = line;
  if (existing) {
    const prior = await gunzipText(await existing.arrayBuffer());
    body = prior + line;
  }
  const compressed = await gzipText(body);
  await bucket.put(key, compressed, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { format: "jsonl.gz" },
  });
}

export interface IngestArchivePayload {
  ingest_ts: string;
  venue: ArchiveSource;
  market_count: number;
  markets: Array<{
    market_id: string;
    title: string;
    topic: string;
    probability: number;
    volume: number | null;
    liquidity: number | null;
    url: string;
    match_key: string;
    observed_at: string;
  }>;
}

export async function archiveMarketSnapshot(
  bucket: R2Bucket | undefined,
  source: ArchiveSource,
  ingestTs: string,
  markets: CanonicalMarket[],
): Promise<string | null> {
  if (!bucket || !markets.length) return null;
  const key = marketsKey(source, ingestTs);
  const payload: IngestArchivePayload = {
    ingest_ts: ingestTs,
    venue: source,
    market_count: markets.length,
    markets: markets.map((m) => ({
      market_id: m.market_id,
      title: m.title,
      topic: m.topic,
      probability: m.probability,
      volume: m.volume ?? null,
      liquidity: m.liquidity ?? null,
      url: m.url,
      match_key: m.match_key,
      observed_at: m.observed_at,
    })),
  };
  await appendJsonlGz(bucket, key, payload);
  return key;
}

export async function archiveKalshiRawPages(
  bucket: R2Bucket | undefined,
  ingestTs: string,
  pages: Array<{ pageIndex: number; payload: unknown }>,
): Promise<string | null> {
  if (!bucket || !pages.length) return null;
  const key = marketsKey("kalshi", ingestTs);
  await appendJsonlGz(bucket, key, {
    ingest_ts: ingestTs,
    venue: "kalshi",
    type: "raw_pages",
    page_count: pages.length,
    pages,
  });
  return key;
}

export async function archivePolymarketOrderbooks(
  bucket: R2Bucket | undefined,
  ingestTs: string,
  snapshot: PolymarketSnapshotResult | null,
): Promise<string[]> {
  if (!bucket || !snapshot?.orderBooks?.length) return [];
  const key = orderbooksBatchKey(ingestTs);
  await appendJsonlGz(bucket, key, {
    ingest_ts: ingestTs,
    book_count: snapshot.orderBooks.length,
    order_books: snapshot.orderBooks.map((book) => ({
      market_id: book.marketId,
      token_id: book.tokenId,
      bids: book.bids,
      asks: book.asks,
      last_trade_price: book.lastTradePrice,
      source_timestamp: book.sourceTimestamp,
    })),
  });
  return [key];
}

export async function archiveDetectSnapshot(
  bucket: R2Bucket | undefined,
  detectTs: string,
  pairs: MatchedPair[],
  opportunityCount: number,
): Promise<string | null> {
  if (!bucket) return null;
  const { day, hour } = partitionFromTs(detectTs);
  const key = `detect/pairs/${day}/${hour}.jsonl.gz`;
  await appendJsonlGz(bucket, key, {
    detect_ts: detectTs,
    pair_count: pairs.length,
    opportunities: opportunityCount,
    pairs: pairs.map((p) => ({
      match_key: p.match_key,
      topic: p.topic,
      title: p.title,
      market_a: p.market_a,
      market_b: p.market_b,
    })),
  });
  return key;
}

/** Legacy poll archive (kept for backward compatibility during migration). */
export { archivePollHistory } from "../history-r2.ts";