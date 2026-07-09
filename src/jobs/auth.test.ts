import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authorizeJob } from "./auth.ts";

function fakeContext(env: Record<string, string | undefined>, authHeader?: string) {
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  return {
    env,
    req: {
      header: (name: string) => (name === "Authorization" ? authHeader : undefined),
    },
    json,
  } as unknown as Parameters<typeof authorizeJob>[0];
}

describe("authorizeJob", () => {
  it("allows requests when POLL_SECRET is missing", () => {
    const denied = authorizeJob(fakeContext({ ENVIRONMENT: "production" }));
    assert.equal(denied, null);
  });

  it("allows preview without a secret", () => {
    const denied = authorizeJob(fakeContext({ ENVIRONMENT: "preview" }));
    assert.equal(denied, null);
  });

  it("rejects wrong bearer token", async () => {
    const denied = authorizeJob(
      fakeContext({ ENVIRONMENT: "production", POLL_SECRET: "secret" }, "Bearer wrong"),
    );
    assert.ok(denied);
    assert.equal(denied!.status, 401);
  });

  it("allows correct bearer token", () => {
    const denied = authorizeJob(
      fakeContext({ ENVIRONMENT: "production", POLL_SECRET: "secret" }, "Bearer secret"),
    );
    assert.equal(denied, null);
  });
});
