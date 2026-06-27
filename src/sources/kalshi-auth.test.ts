import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import {
  isPkcs1RsaPrivateKey,
  kalshiSignPath,
  normalizeKalshiPrivateKeyPem,
  signKalshiRequest,
} from "./kalshi-auth.ts";

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

describe("signKalshiRequest", () => {
  it("signs Kalshi PKCS#1 RSA private keys", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs1Pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    assert.equal(isPkcs1RsaPrivateKey(pkcs1Pem), true);
    const signature = await signKalshiRequest(
      pkcs1Pem,
      "1703123456789",
      "GET",
      "/trade-api/v2/markets",
    );
    assert.ok(signature.length > 20);
  });
});
