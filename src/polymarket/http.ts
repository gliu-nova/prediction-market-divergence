import type { PolymarketIngestConfig } from "./config.ts";

export type FetchLike = typeof fetch;

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  debug(message, meta) {
    if (meta) console.debug(message, meta);
    else console.debug(message);
  },
  info(message, meta) {
    if (meta) console.info(message, meta);
    else console.info(message);
  },
  warn(message, meta) {
    if (meta) console.warn(message, meta);
    else console.warn(message);
  },
  error(message, meta) {
    if (meta) console.error(message, meta);
    else console.error(message);
  },
};

export class RateLimitedClient {
  private lastRequestAt = 0;
  readonly config: PolymarketIngestConfig;
  readonly fetchFn: FetchLike;
  readonly logger: Logger;

  constructor(
    config: PolymarketIngestConfig,
    fetchFn: FetchLike = fetch,
    logger: Logger = consoleLogger,
  ) {
    this.config = config;
    this.fetchFn = fetchFn;
    this.logger = logger;
  }

  private async throttle(): Promise<void> {
    const waitMs = this.config.minRequestIntervalMs - (Date.now() - this.lastRequestAt);
    if (waitMs > 0) await sleep(waitMs);
    this.lastRequestAt = Date.now();
  }

  private retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
    if (retryAfterHeader) {
      const seconds = Number(retryAfterHeader);
      if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
    }
    const base = this.config.retryBaseMs * 2 ** attempt;
    return base + Math.floor(Math.random() * base * 0.25);
  }

  async fetchJson<T>(
    url: string,
    init: RequestInit = {},
  ): Promise<T> {
    for (let attempt = 0; attempt < this.config.maxRetries; attempt += 1) {
      await this.throttle();
      const resp = await this.fetchFn(url, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
      });

      if ((resp.status === 429 || resp.status >= 500) && attempt < this.config.maxRetries - 1) {
        const delay = this.retryDelayMs(attempt, resp.headers.get("Retry-After"));
        this.logger.warn("polymarket request retry", { url, status: resp.status, attempt, delay });
        await sleep(delay);
        continue;
      }

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`Polymarket request failed: ${resp.status} ${url} ${body.slice(0, 200)}`);
      }

      return (await resp.json()) as T;
    }

    throw new Error(`Polymarket request exhausted retries: ${url}`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}