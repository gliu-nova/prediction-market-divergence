const BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";

export async function fetchKalshiMarkets(fetchedAt: string): Promise<Record<string, unknown>[]> {
  const resp = await fetch(`${BASE_URL}/markets?limit=100&status=open`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`Kalshi fetch failed: ${resp.status}`);
  const data = (await resp.json()) as { markets?: Record<string, unknown>[] } | Record<string, unknown>[];
  const markets = Array.isArray(data) ? data : data.markets ?? [];
  return markets.map((row) => ({ ...row, venue: "kalshi", fetched_at: fetchedAt }));
}

export async function kalshiHealthy(): Promise<boolean> {
  try {
    const resp = await fetch(`${BASE_URL}/markets?limit=1`);
    return resp.ok;
  } catch {
    return false;
  }
}