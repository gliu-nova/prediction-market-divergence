import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { saveKalshiIngest } from "./kalshi-ingest.ts";
import type { CanonicalMarket } from "./types.ts";
import type { KalshiIngestPage } from "./sources/kalshi.ts";

class MockD1Statement {
  readonly sql: string;
  readonly binds: unknown[];

  constructor(sql: string, binds: unknown[] = []) {
    this.sql = sql;
    this.binds = binds;
  }

  bind(...values: unknown[]): MockD1Statement {
    return new MockD1Statement(this.sql, values);
  }

  get query(): { sql: string; binds: unknown[] } {
    return { sql: this.sql, binds: this.binds };
  }
}

class MockD1Database {
  readonly statements: Array<{ sql: string; binds: unknown[] }> = [];

  prepare(sql: string): MockD1Statement {
    return new MockD1Statement(sql);
  }

  async batch(statements: MockD1Statement[]): Promise<void> {
    for (const statement of statements) {
      this.statements.push(statement.query);
    }
  }
}

describe("saveKalshiIngest", () => {
  it("stores ingest batch metadata and normalized market records for a poll", async () => {
    const db = new MockD1Database();
    const pollTs = "2026-06-26T12:00:00.000Z";
    const pages: KalshiIngestPage[] = [
      {
        pageIndex: 0,
        requestCursor: null,
        responseCursor: "cursor-2",
        marketCount: 2,
        payload: { markets: [{ ticker: "A" }, { ticker: "B" }], cursor: "cursor-2" },
      },
      {
        pageIndex: 1,
        requestCursor: "cursor-2",
        responseCursor: null,
        marketCount: 1,
        payload: { markets: [{ ticker: "C" }], cursor: null },
      },
    ];
    const normalized: CanonicalMarket[] = [
      {
        canonical_id: "macro:recession-2026",
        title: "US recession in 2026",
        topic: "Macro",
        venue: "kalshi",
        market_id: "RECESSION-2026",
        probability: 0.22,
        volume: 1000,
        liquidity: 500,
        url: "https://kalshi.com/markets/recession-2026",
        observed_at: pollTs,
        match_key: "macro:recession-2026",
      },
    ];

    const batch = await saveKalshiIngest(db as unknown as D1Database, pollTs, pages, normalized);

    assert.equal(batch.pageCount, 2);
    assert.equal(batch.rawMarketCount, 3);
    assert.equal(batch.normalizedCount, 1);

    const sql = db.statements.map((s) => s.sql);
    assert.ok(sql.some((q) => q.includes("INSERT INTO kalshi_ingest_batches")));
    assert.equal(sql.filter((q) => q.includes("INSERT INTO kalshi_raw_pages")).length, 0);
    assert.equal(sql.filter((q) => q.includes("INSERT INTO kalshi_normalized_markets")).length, 1);

    const normalizedInsert = db.statements.find((s) => s.sql.includes("INSERT INTO kalshi_normalized_markets"));
    assert.equal(normalizedInsert?.binds[1], "RECESSION-2026");
    assert.equal(normalizedInsert?.binds[3], "US recession in 2026");
  });
});