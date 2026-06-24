import { handle } from "hono/cloudflare-pages";
import app from "../src/index";
import type { Env } from "../src/types";

const hono = handle(app);

export const onRequest: PagesFunction<Env> = async (context) => {
  const response = await hono(context);
  if (response.status !== 404) {
    return response;
  }
  // Non-API paths (/, /index.html, /css/*) fall through to static assets in public/
  return context.env.ASSETS.fetch(context.request);
};