import { mkdir, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PolymarketSnapshotResult } from "./types.ts";

const LOCAL_DATA_DIR = path.join(process.cwd(), "data", "polymarket");

export async function savePolymarketSnapshotLocal(result: PolymarketSnapshotResult): Promise<string> {
  await mkdir(LOCAL_DATA_DIR, { recursive: true });
  const file = path.join(LOCAL_DATA_DIR, `snapshot-${result.run.id}.json`);
  await writeFile(file, JSON.stringify(result, null, 2), "utf8");
  await appendFile(path.join(LOCAL_DATA_DIR, "ingestion-runs.jsonl"), `${JSON.stringify(result.run)}\n`, "utf8");
  return file;
}