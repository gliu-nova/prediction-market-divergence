import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CanonicalMarket } from "../types.ts";
import { archiveMarketSnapshot, marketsManifestKey, mergeManifestKeys } from "./r2.ts";

const market: CanonicalMarket = {
  canonical_id: "c1",
  title: "Test market",
  topic: "test",
  venue: "polymarket",
  market_id: "m1",
  probability: 0.5,
  volume: 10,
  liquidity: 3,
  url: "https://example.com/m1",
  observed_at: "2026-10-08T13:31:48.000Z",
  match_key: "mk",
};

function fakeBucket() {
  const objects = new Map<string, string | Uint8Array>();
  return {
    objects,
    async get(key: string) {
      const value = objects.get(key);
      if (value === undefined) return null;
      const text = typeof value === "string" ? value : new TextDecoder().decode(value);
      return { text: async () => text };
    },
    async put(key: string, value: string | Uint8Array) {
      objects.set(key, value);
    },
  };
}

describe("mergeManifestKeys", () => {
  it("keeps prior keys and appends the new one", () => {
    assert.deepEqual(mergeManifestKeys({ keys: ["a.jsonl.gz", "b.jsonl.gz"] }, "c.jsonl.gz"), [
      "a.jsonl.gz",
      "b.jsonl.gz",
      "c.jsonl.gz",
    ]);
  });

  it("drops a duplicate and replaces a corrupt body", () => {
    assert.deepEqual(mergeManifestKeys({ keys: ["a.jsonl.gz", 1, "a.jsonl.gz"] }, "a.jsonl.gz"), [
      "a.jsonl.gz",
    ]);
    assert.deepEqual(mergeManifestKeys("nope", "a.jsonl.gz"), ["a.jsonl.gz"]);
  });
});

describe("archiveMarketSnapshot manifest", () => {
  it("records each run under the venue-day manifest", async () => {
    const bucket = fakeBucket();
    const key1 = await archiveMarketSnapshot(
      bucket as unknown as R2Bucket,
      "polymarket",
      "2026-10-08T13:31:48.000Z",
      [market],
    );
    const key2 = await archiveMarketSnapshot(
      bucket as unknown as R2Bucket,
      "polymarket",
      "2026-10-08T14:02:03.000Z",
      [market],
    );
    const manifestKey = marketsManifestKey("polymarket", "2026-10-08");
    const manifest = JSON.parse(String(bucket.objects.get(manifestKey)));
    assert.equal(key1, "polymarket/markets/2026-10-08/13-20261008133148.jsonl.gz");
    assert.equal(key2, "polymarket/markets/2026-10-08/14-20261008140203.jsonl.gz");
    assert.deepEqual(manifest.keys, [key1, key2]);
    assert.equal(bucket.objects.has(key1!), true);
    assert.equal(typeof bucket.objects.get(key1!), "object");
  });

  it("keeps a different day in its own manifest and recovers a corrupt one", async () => {
    const bucket = fakeBucket();
    const dayKey = marketsManifestKey("kalshi", "2026-10-08");
    bucket.objects.set(dayKey, "not-json");
    const key = await archiveMarketSnapshot(
      bucket as unknown as R2Bucket,
      "kalshi",
      "2026-10-08T01:00:00.000Z",
      [market],
    );
    await archiveMarketSnapshot(bucket as unknown as R2Bucket, "kalshi", "2026-10-09T01:00:00.000Z", [market]);
    assert.deepEqual(JSON.parse(String(bucket.objects.get(dayKey))).keys, [key]);
    assert.equal(
      JSON.parse(String(bucket.objects.get(marketsManifestKey("kalshi", "2026-10-09")))).keys.length,
      1,
    );
  });
});
