const BASE_URL = "https://gamma-api.polymarket.com";

export async function fetchPolymarketMarkets(fetchedAt: string): Promise<Record<string, unknown>[]> {
  const resp = await fetch(`${BASE_URL}/markets?active=true&limit=100`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`Polymarket fetch failed: ${resp.status}`);
  const data = (await resp.json()) as Record<string, unknown>[];
  if (!Array.isArray(data)) throw new Error("Polymarket returned unexpected payload");
  return data.map((row) => ({ ...row, venue: "polymarket", fetched_at: fetchedAt }));
}

export async function polymarketHealthy(): Promise<boolean> {
  try {
    const resp = await fetch(`${BASE_URL}/markets?limit=1`);
    return resp.ok;
  } catch {
    return false;
  }
}