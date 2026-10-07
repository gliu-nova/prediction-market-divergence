import { handle, type EventContext } from "hono/cloudflare-pages";
import app from "../src/index";
import type { Env } from "../src/types";

const hono = handle(app);

export const onRequest: PagesFunction<Env> = async (context) => {
  // Hono 4.13 requires `props` on its Pages EventContext. Cloudflare's
  // PagesFunction context does not include it, and handle() does not read it.
  const response = await hono(context as EventContext<Env>);
  if (response.status !== 404) {
    return response;
  }
  // Non-API paths (/, /index.html, /css/*) fall through to static assets in public/
  return context.env.ASSETS.fetch(context.request);
};