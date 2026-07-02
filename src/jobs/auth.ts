import type { Context } from "hono";
import type { Env } from "../types.ts";

export function authorizeJob(c: Context<{ Bindings: Env }>): Response | null {
  const secret = c.env.POLL_SECRET;
  if (!secret) return null;
  const auth = c.req.header("Authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  return null;
}