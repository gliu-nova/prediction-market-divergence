import { runPoll } from "../src/poll";
import { ensureTables } from "../src/storage";
import type { Env } from "../src/types";

export async function onSchedule(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  await ensureTables(env.DB);
  await runPoll(env);
}