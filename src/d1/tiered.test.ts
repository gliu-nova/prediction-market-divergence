import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  D1_MAX_BOUND_PARAMS,
  LATEST_PRICE_MULTI_ROW_CHUNK,
  LATEST_PRICE_PARAMS_PER_ROW,
  upsertLatestPrices,
} from "./tiered.ts";
import type { CanonicalMarket } from "../types.ts";

class MockD1Statement {
  readonly sql: string;
  readonly binds: unknown[];
  readonly db: MockD1Database;

  constructor(db: MockD1Database, sql: string, binds: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.binds = binds;
  }

  bind(...values: unknown[]): MockD1Statement {
    return new MockD1Statement(this.db, this.sql, values);
  }

  async run(): Promise<void> {
    this.db.runs.push({ sql: this.sql, binds: this.binds });
  }
}

class MockD1Database {
  readonly runs: Array<{ sql: string; binds: unknown[] }> = [];

  prepare(sql: string): MockD1Statement {
    return new MockD1Statement(this, sql);
  }
}

function countSqlPlaceholders(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

function sampleMarket(index: number, ingestTs: string): CanonicalMarket {
  return {
    canonical_id: `topic:market-${index}`,
    title: `Market ${index}`,
    topic: "Topic",
    venue: index % 2 === 0 ? "kalshi" : "polymarket",
    market_id: `M-${index}`,
    probability: 0.5,
    volume: 1000,
    liquidity: 500,
    url: `https://example.com/${index}`,
    observed_at: ingestTs,
    match_key: `topic:market-${index}`,
  };
}

describe("upsertLatestPrices D1 chunking", () => {
  it("keeps multi-row chunk size under D1 bound-parameter limit", () => {
    assert.equal(LATEST_PRICE_PARAMS_PER_ROW, 8);
    assert.equal(LATEST_PRICE_MULTI_ROW_CHUNK, 12);
    assert.ok(LATEST_PRICE_MULTI_ROW_CHUNK * LATEST_PRICE_PARAMS_PER_ROW <= D1_MAX_BOUND_PARAMS);
  });

  it("splits large upserts so each statement stays within D1 limits", async () => {
    const db = new MockD1Database();
    const ingestTs = "2026-07-02T12:00:00.000Z";
    const markets = Array.from({ length: 30 }, (_, i) => sampleMarket(i, ingestTs));

    await upsertLatestPrices(db as unknown as D1Database, markets, ingestTs);

    assert.equal(db.runs.length, 3);
    for (const run of db.runs) {
      assert.ok(run.sql.includes("INSERT INTO latest_prices"));
      assert.ok(countSqlPlaceholders(run.sql) <= D1_MAX_BOUND_PARAMS);
      assert.equal(run.binds.length, countSqlPlaceholders(run.sql));
      assert.ok(run.binds.length <= D1_MAX_BOUND_PARAMS);
    }
    assert.equal(db.runs[0]!.binds.length, LATEST_PRICE_MULTI_ROW_CHUNK * LATEST_PRICE_PARAMS_PER_ROW);
    assert.equal(db.runs[2]!.binds.length, 6 * LATEST_PRICE_PARAMS_PER_ROW);
  });
});
