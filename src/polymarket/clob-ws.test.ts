import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultPolymarketConfig } from "./config.ts";

describe("streamPolymarketMarketChannel", () => {
  it("requires ws package for streaming", async () => {
    const { streamPolymarketMarketChannel } = await import("./clob-ws.ts");
    try {
      await import("ws");
    } catch {
      await assert.rejects(
        () =>
          streamPolymarketMarketChannel(defaultPolymarketConfig, {
            tokenIds: ["token-1"],
            durationMs: 100,
          }),
        /requires the ws package/,
      );
      return;
    }
    assert.ok(typeof streamPolymarketMarketChannel === "function");
  });
});