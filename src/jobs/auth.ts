import type { Context } from "hono";
import type { Env } from "../types.ts";

/**
 * Authorize mutating job endpoints.
 * Production fails closed when POLL_SECRET is unset; preview/local may omit it.
 */
export function authorizeJob(c: Context<{ Bindings: Env }>): Response | null {
  const secret = c.env.POLL_SECRET?.trim();
  const environment = (c.env.ENVIRONMENT ?? "production").toLowerCase();
  const isProduction = environment === "production";

  if (!secret) {
    if (isProduction) {
      return c.json({ detail: "POLL_SECRET is required in production" }, 503);
    }
    return null;
  }

  const auth = c.req.header("Authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  return null;
}