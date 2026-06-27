export interface KalshiAuthCredentials {
  accessKey: string;
  privateKeyPem: string;
}

export function kalshiSignPath(url: string): string {
  return new URL(url).pathname;
}

export function normalizeKalshiPrivateKeyPem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
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
  return bytes.buffer;
}

async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
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
