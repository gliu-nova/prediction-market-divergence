import { runPoll } from "../src/poll";
import { ensureTables } from "../src/storage";
import type { Env } from "../src/types";

export async function onSchedule(
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  ctx.waitUntil(
    (async () => {
      await ensureTables(env.DB);
      await runPoll(env);
    })(),
  );
}