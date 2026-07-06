import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkArray, d1RowsPerStatement, D1_MAX_BOUND_PARAMS } from "./limits.ts";

describe("d1RowsPerStatement", () => {
  it("respects D1 100-parameter cap", () => {
    assert.equal(D1_MAX_BOUND_PARAMS, 100);
    assert.equal(d1RowsPerStatement(8), 12);
    assert.equal(d1RowsPerStatement(12), 8);
    assert.equal(d1RowsPerStatement(9), 11);
  });

  it("accounts for reserved parameters", () => {
    assert.equal(d1RowsPerStatement(8, 4), 12);
  });
});

describe("chunkArray", () => {
  it("splits arrays into fixed-size chunks", () => {
    assert.deepEqual([...chunkArray([1, 2, 3, 4, 5], 2)], [[1, 2], [3, 4], [5]]);
  });
});
