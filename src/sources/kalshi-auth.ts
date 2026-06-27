export interface KalshiAuthCredentials {
  accessKey: string;
  privateKeyPem: string;
}

export function kalshiSignPath(url: string): string {
  return new URL(url).pathname;
}

export function normalizeKalshiPrivateKeyPem(pem: string): string {
  let normalized = pem.trim();
  if (normalized.includes("\\n")) {
    normalized = normalized.replace(/\\n/g, "\n");
  }
  return normalized;
}

export function isPkcs1RsaPrivateKey(pem: string): boolean {
  return /BEGIN RSA PRIVATE KEY/.test(normalizeKalshiPrivateKeyPem(pem));
}

function pemBodyToDer(pem: string): Uint8Array {
  const normalized = normalizeKalshiPrivateKeyPem(pem);
  const base64 = normalized
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Kalshi downloads PKCS#1 (`BEGIN RSA PRIVATE KEY`); Web Crypto needs PKCS#8. */
export function pkcs1DerToPkcs8Der(pkcs1: Uint8Array): Uint8Array {
  const oid = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const pkcs1Len = pkcs1.length;
  const octetStringHeader =
    pkcs1Len > 255
      ? new Uint8Array([0x04, 0x82, (pkcs1Len >> 8) & 0xff, pkcs1Len & 0xff])
      : new Uint8Array([0x04, pkcs1Len]);

  const inner = new Uint8Array(
    version.length + oid.length + octetStringHeader.length + pkcs1.length,
  );
  let offset = 0;
  inner.set(version, offset);
  offset += version.length;
  inner.set(oid, offset);
  offset += oid.length;
  inner.set(octetStringHeader, offset);
  offset += octetStringHeader.length;
  inner.set(pkcs1, offset);

  const innerLen = inner.length;
  const seqHeader =
    innerLen > 255
      ? new Uint8Array([0x30, 0x82, (innerLen >> 8) & 0xff, innerLen & 0xff])
      : new Uint8Array([0x30, innerLen]);

  const pkcs8 = new Uint8Array(seqHeader.length + inner.length);
  pkcs8.set(seqHeader, 0);
  pkcs8.set(inner, seqHeader.length);
  return pkcs8;
}

async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  const normalized = normalizeKalshiPrivateKeyPem(privateKeyPem);
  const der = pemBodyToDer(normalized);
  const keyData = isPkcs1RsaPrivateKey(normalized) ? pkcs1DerToPkcs8Der(der) : der;
  return crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function signKalshiRequest(
  privateKeyPem: string,
  timestampMs: string,
  method: string,
  signPath: string,
): Promise<string> {
  const message = `${timestampMs}${method.toUpperCase()}${signPath}`;
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    key,
    new TextEncoder().encode(message),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export async function verifyKalshiAuthCredentials(credentials: KalshiAuthCredentials): Promise<boolean> {
  try {
    await signKalshiRequest(credentials.privateKeyPem, "0", "GET", "/trade-api/v2/markets");
    return true;
  } catch {
    return false;
  }
}
export async function createKalshiAuthHeaders(
  credentials: KalshiAuthCredentials,
  method: string,
  url: string,
): Promise<Record<string, string>> {
  const timestampMs = String(Date.now());
  const signPath = kalshiSignPath(url);
  const signature = await signKalshiRequest(credentials.privateKeyPem, timestampMs, method, signPath);
  return {
    "KALSHI-ACCESS-KEY": credentials.accessKey,
    "KALSHI-ACCESS-TIMESTAMP": timestampMs,
    "KALSHI-ACCESS-SIGNATURE": signature,
  };
}
