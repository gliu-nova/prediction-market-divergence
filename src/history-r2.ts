import type { PolymarketSnapshotResult } from "./polymarket/types.ts";
import type { CanonicalMarket, MatchedPair } from "./types.ts";

export interface PollHistorySummary {
  poll_ts: string;
  markets_total: number;
  kalshi_markets: number;
  polymarket_markets: number;
  matched_pairs: number;
  opportunities: number;
}

function r2Key(pollTs: string, suffix: string): string {
  const day = pollTs.slice(0, 10);
  const safeTs = pollTs.replace(/[:.]/g, "-");
  return `polls/${day}/${safeTs}/${suffix}`;
}

export async function archivePollHistory(
  bucket: R2Bucket | undefined,
  pollTs: string,
  polymarket: PolymarketSnapshotResult | null,
  summary: PollHistorySummary,
  markets: CanonicalMarket[],
  pairs: MatchedPair[],
): Promise<string | null> {
  if (!bucket) return null;

  const writes: Array<{ key: string; body: string }> = [
    { key: r2Key(pollTs, "summary.json"), body: JSON.stringify(summary) },
    {
      key: r2Key(pollTs, "ingested-markets.json"),
      body: JSON.stringify({
        poll_ts: pollTs,
        markets: markets.map((m) => ({
          venue: m.venue,
          market_id: m.market_id,
          title: m.title,
          topic: m.topic,
          probability: m.probability,
          volume: m.volume,
          liquidity: m.liquidity,
          url: m.url,
          match_key: m.match_key,
        })),
      }),
    },
    {
      key: r2Key(pollTs, "matched-pairs.json"),
      body: JSON.stringify({
        poll_ts: pollTs,
        pairs: pairs.map((p) => ({
          match_key: p.match_key,
          topic: p.topic,
          title: p.title,
          market_a: p.market_a,
          market_b: p.market_b,
        })),
      }),
    },
  ];

  if (polymarket) {
    writes.push({
      key: r2Key(pollTs, "polymarket-snapshot.json"),
      body: JSON.stringify(polymarket),
    });
  }

  await Promise.all(
    writes.map((item) =>
      bucket.put(item.key, item.body, {
        httpMetadata: { contentType: "application/json" },
      }),
    ),
  );

  return writes[0]!.key;
}