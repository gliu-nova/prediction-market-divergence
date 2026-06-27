import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { kalshiSignPath, normalizeKalshiPrivateKeyPem } from "./kalshi-auth.ts";

describe("kalshiSignPath", () => {
  it("uses pathname only, without query parameters", () => {
    const url =
      "https://api.elections.kalshi.com/trade-api/v2/markets?limit=1000&status=open&cursor=abc";
    assert.equal(kalshiSignPath(url), "/trade-api/v2/markets");
  });
});

describe("normalizeKalshiPrivateKeyPem", () => {
  it("converts escaped newlines from secret storage", () => {
    assert.equal(normalizeKalshiPrivateKeyPem("line1\\nline2"), "line1\nline2");
  });
});
