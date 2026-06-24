const MOCK_KALSHI = [
  {
    ticker: "FED-CUT-SEP-2026",
    title: "Fed cuts rates in September 2026 meeting",
    yes_price: 0.42,
    volume: 125000,
    liquidity: 45000,
    url: "https://kalshi.com/markets/fed-cut-sep-2026",
    topic: "Fed rates",
    match_key: "fed-rates:fed-cut-sep-2026",
  },
  {
    ticker: "BTC-100K-2026",
    title: "Bitcoin above $100k by end of 2026",
    yes_price: 0.38,
    volume: 89000,
    liquidity: 22000,
    url: "https://kalshi.com/markets/btc-100k-2026",
    topic: "Bitcoin",
    match_key: "bitcoin:btc-100k-2026",
  },
  {
    ticker: "RECESSION-2026",
    title: "US recession in 2026",
    yes_price: 0.22,
    volume: 210000,
    liquidity: 78000,
    url: "https://kalshi.com/markets/recession-2026",
    topic: "Macro",
    match_key: "macro:recession-2026",
  },
];

const MOCK_POLYMARKET = [
  {
    id: "poly-fed-cut-sep-2026",
    question: "Will the Fed cut rates in September 2026?",
    yes_price: 0.55,
    volume: 340000,
    liquidity: 120000,
    url: "https://polymarket.com/event/fed-cut-sep-2026",
    topic: "Fed rates",
    match_key: "fed-rates:fed-cut-sep-2026",
  },
  {
    id: "poly-btc-100k-2026",
    question: "Will Bitcoin exceed $100,000 in 2026?",
    yes_price: 0.41,
    volume: 520000,
    liquidity: 95000,
    url: "https://polymarket.com/event/btc-100k-2026",
    topic: "Bitcoin",
    match_key: "bitcoin:btc-100k-2026",
  },
  {
    id: "poly-recession-2026",
    question: "US recession in 2026?",
    yes_price: 0.19,
    volume: 180000,
    liquidity: 65000,
    url: "https://polymarket.com/event/recession-2026",
    topic: "Macro",
    match_key: "macro:recession-2026",
  },
];

export function fetchMockMarkets(venue: "kalshi" | "polymarket", fetchedAt: string): Record<string, unknown>[] {
  const rows = venue === "kalshi" ? MOCK_KALSHI : MOCK_POLYMARKET;
  return rows.map((row) => ({ ...row, venue, fetched_at: fetchedAt }));
}