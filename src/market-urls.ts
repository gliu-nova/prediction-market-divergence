function kalshiSeriesTicker(raw: Record<string, unknown>, eventTicker: string): string {
  if (raw.series_ticker) return String(raw.series_ticker).toUpperCase();
  const dash = eventTicker.indexOf("-");
  return (dash > 0 ? eventTicker.slice(0, dash) : eventTicker).toUpperCase();
}

export function buildKalshiMarketUrl(raw: Record<string, unknown>): string {
  const marketTicker = String(raw.ticker ?? raw.market_ticker ?? "").toUpperCase();
  const eventTicker = String(raw.event_ticker ?? "").toUpperCase();
  if (eventTicker && marketTicker) {
    const seriesTicker = kalshiSeriesTicker(raw, eventTicker);
    return `https://kalshi.com/markets/${seriesTicker}/${eventTicker}/${marketTicker}`;
  }
  if (marketTicker) return `https://kalshi.com/markets/${marketTicker}`;
  return "";
}

export function buildPolymarketMarketUrl(raw: Record<string, unknown>, marketId: string): string {
  const slug = String(raw.slug ?? marketId);
  return `https://polymarket.com/market/${slug}`;
}
