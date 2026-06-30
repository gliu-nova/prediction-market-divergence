import { polymarketConfigFromEnv } from "../src/polymarket/config.ts";
import { fetchMarketBySlugOrId, discoverMarkets } from "../src/polymarket/discovery.ts";
import { fetchRecentTrades } from "../src/polymarket/data-api.ts";
import { RateLimitedClient } from "../src/polymarket/http.ts";
import { runPolymarketSnapshot } from "../src/polymarket/snapshot.ts";
import { savePolymarketSnapshotLocal } from "../src/polymarket/storage-local.ts";
import { streamPolymarketMarketChannel } from "../src/polymarket/clob-ws.ts";
import { extractOutcomeTokens, normalizeGammaMarket, primaryYesToken } from "../src/polymarket/normalize.ts";

function usage(): never {
  console.log(`Usage:
  npm run polymarket -- discover --limit 100
  npm run polymarket -- snapshot --active-only
  npm run polymarket -- stream --market-id <id> [--duration-ms 10000]
  npm run polymarket -- backfill-trades --since 2026-06-01 [--market-id <id>]
  npm run polymarket -- inspect-market <slug-or-id>`);
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = { _: "" };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    } else {
      positionals.push(arg);
    }
  }
  out._ = positionals.join(" ");
  out.command = positionals[0] ?? "";
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = String(args.command ?? "");
  if (!command) usage();

  const config = polymarketConfigFromEnv(process.env as Record<string, string | undefined>);
  const client = new RateLimitedClient(config);

  if (command === "discover") {
    const limit = Number(args.limit ?? config.discoveryPageSize);
    const result = await discoverMarkets(config, client, {
      activeOnly: args["active-only"] !== false,
      limit,
      maxMarkets: Number(args.limit ?? limit),
    });
    console.log(JSON.stringify({ count: result.markets.length, truncated: result.truncated, markets: result.markets }, null, 2));
    return;
  }

  if (command === "snapshot") {
    const result = await runPolymarketSnapshot(config, {
      activeOnly: args["active-only"] !== false,
      includeOrderBooks: true,
      includeTrades: false,
      mode: "snapshot",
    });
    const file = await savePolymarketSnapshotLocal(result);
    console.log(JSON.stringify({ savedTo: file, run: result.run, markets: result.markets.length }, null, 2));
    return;
  }

  if (command === "stream") {
    const marketId = String(args["market-id"] ?? "");
    if (!marketId) usage();
    const raw = await fetchMarketBySlugOrId(config, client, marketId);
    if (!raw) throw new Error(`Market not found: ${marketId}`);
    const market = normalizeGammaMarket(raw);
    if (!market) throw new Error(`Unable to normalize market: ${marketId}`);
    const token = primaryYesToken(extractOutcomeTokens(market, raw));
    if (!token) throw new Error(`No CLOB token ids for market: ${marketId}`);
    const events = await streamPolymarketMarketChannel(config, {
      tokenIds: [token.tokenId],
      durationMs: Number(args["duration-ms"] ?? 10_000),
      onEvent: (event) => console.log(JSON.stringify(event)),
    });
    console.log(JSON.stringify({ events: events.length }, null, 2));
    return;
  }

  if (command === "backfill-trades") {
    const since = String(args.since ?? "");
    const trades = await fetchRecentTrades(config, client, {
      marketId: args["market-id"] ? String(args["market-id"]) : undefined,
      since: since || undefined,
      limit: config.tradeBackfillLimit,
    });
    console.log(JSON.stringify({ count: trades.length, trades }, null, 2));
    return;
  }

  if (command === "inspect-market") {
    const target = String(args._).split(" ").slice(1).join(" ") || String(args["market-id"] ?? "");
    if (!target) usage();
    const raw = await fetchMarketBySlugOrId(config, client, target);
    if (!raw) throw new Error(`Market not found: ${target}`);
    const market = normalizeGammaMarket(raw);
    const tokens = market ? extractOutcomeTokens(market, raw) : [];
    console.log(JSON.stringify({ raw, market, tokens }, null, 2));
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});