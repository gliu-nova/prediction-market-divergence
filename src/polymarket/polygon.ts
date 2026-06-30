import type { PolymarketIngestConfig } from "./config.ts";
import { RateLimitedClient, type Logger } from "./http.ts";

/**
 * Optional Polygon RPC lookups. Disabled unless POLYGON_RPC_URL is configured.
 * First implementation keeps this lightweight and returns no rows by default.
 */
export async function fetchPolygonActivityHint(
  config: PolymarketIngestConfig,
  _client: RateLimitedClient,
  conditionId: string,
  logger: Logger,
): Promise<{ conditionId: string; note: string } | null> {
  if (!config.endpoints.polygonRpcUrl) return null;
  logger.debug("polygon lookup skipped in v1", { conditionId, rpc: config.endpoints.polygonRpcUrl });
  return {
    conditionId,
    note: "Polygon RPC configured but on-chain trade decoding is not enabled in this build.",
  };
}