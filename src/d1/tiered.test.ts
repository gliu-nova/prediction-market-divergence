import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { upsertLatestPricesIfChanged } from "./tiered.ts";
import type { CanonicalMarket } from "../types.ts";

interface PriceRow {
  venue: string;
  market_id: string;
  probability: number;
  volume: number | null;
  liquidity: number | null;
}

class MockStatement {
  readonly db: MockPriceDb;
  readonly sql: string;
  readonly binds: unknown[];

  constructor(db: MockPriceDb, sql: string, binds: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.binds = binds;
  }

  bind(...values: unknown[]): MockStatement {
    return new MockStatement(this.db, this.sql, values);
  }

  async all(): Promise<{ results: PriceRow[] }> {
    this.db.selects.push({ sql: this.sql, binds: [...this.binds] });
    if (!this.sql.includes("market_id IN")) {
      throw new Error(`unscoped latest_prices read: ${this.sql}`);
    }
    const venue = String(this.binds[0]);
    const ids = new Set(this.binds.slice(1).map(String));
    return {
      results: this.db.priors.filter((row) => row.venue === venue && ids.has(row.market_id)),
    };
  }
}

class MockPriceDb {
  readonly selects: Array<{ sql: string; binds: unknown[] }> = [];
  readonly writes: Array<{ sql: string; binds: unknown[] }> = [];
  priors: PriceRow[] = [];

  prepare(sql: string): MockStatement {
    return new MockStatement(this, sql);
  }

  async batch(statements: MockStatement[]): Promise<void> {
    for (const statement of statements) {
      this.writes.push({ sql: statement.sql, binds: [...statement.binds] });
    }
  }
}

function market(partial: Partial<CanonicalMarket> & Pick<CanonicalMarket, "venue" | "market_id">): CanonicalMarket {
  return {
    canonical_id: partial.market_id,
    title: partial.market_id,
    topic: "Macro",
    venue: partial.venue,
    market_id: partial.market_id,
    probability: partial.probability ?? 0.5,
    volume: partial.volume ?? 10,
    liquidity: partial.liquidity ?? 5,
    url: "https://example.test/m",
    observed_at: "2026-10-08T00:00:00.000Z",
    match_key: partial.market_id,
  };
}

describe("upsertLatestPricesIfChanged", () => {
  it("reads and writes only the markets in this batch", async () => {
    const db = new MockPriceDb();
    db.priors = [
      { venue: "kalshi", market_id: "SAME", probability: 0.4, volume: 10, liquidity: 5 },
      { venue: "kalshi", market_id: "MOVED", probability: 0.2, volume: 10, liquidity: 5 },
      { venue: "kalshi", market_id: "OTHER", probability: 0.9, volume: 1, liquidity: 1 },
    ];

    const result = await upsertLatestPricesIfChanged(
      db as unknown as D1Database,
      [
        market({ venue: "kalshi", market_id: "SAME", probability: 0.4 }),
        market({ venue: "kalshi", market_id: "MOVED", probability: 0.8 }),
        market({ venue: "polymarket", market_id: "NEW", probability: 0.3 }),
      ],
      "2026-10-08T00:00:00.000Z",
    );

    assert.equal(result.skipped, 1);
    assert.equal(result.written, 2);
    assert.deepEqual(
      result.changed.map((row) => row.market_id),
      ["MOVED", "NEW"],
    );
    assert.equal(db.selects.length, 2);
    assert.ok(db.selects.every((query) => query.sql.includes("market_id IN")));
    assert.deepEqual(db.selects[0]?.binds, ["kalshi", "SAME", "MOVED"]);
    assert.deepEqual(db.selects[1]?.binds, ["polymarket", "NEW"]);
    const writtenIds = db.writes.flatMap((query) => query.binds);
    assert.equal(writtenIds.includes("MOVED"), true);
    assert.equal(writtenIds.includes("NEW"), true);
    assert.equal(writtenIds.includes("SAME"), false);
    assert.equal(writtenIds.includes("OTHER"), false);
  });

  it("chunks a venue under the D1 100-parameter cap", async () => {
    const db = new MockPriceDb();
    const markets = Array.from({ length: 100 }, (_, index) =>
      market({ venue: "kalshi", market_id: `M${index}`, probability: 0.5 }),
    );
    db.priors = markets.map((row) => ({
      venue: row.venue,
      market_id: row.market_id,
      probability: row.probability,
      volume: row.volume ?? null,
      liquidity: row.liquidity ?? null,
    }));

    const result = await upsertLatestPricesIfChanged(db as unknown as D1Database, markets, "2026-10-08T00:00:00.000Z");

    assert.equal(result.written, 0);
    assert.equal(result.skipped, 100);
    assert.equal(db.writes.length, 0);
    assert.equal(db.selects.length, 2);
    assert.equal(db.selects[0]?.binds.length, 100);
    assert.equal(db.selects[1]?.binds.length, 2);
    assert.ok(db.selects.every((query) => query.binds.length <= 100));
  });
});
