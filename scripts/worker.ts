import { config } from "dotenv";

config({ path: ".env.local" });
config();

const intervalSeconds = Number(process.env.WORKER_INTERVAL_SECONDS ?? 60);
if (!Number.isInteger(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 300) {
  throw new Error("WORKER_INTERVAL_SECONDS must be an integer from 30 to 300");
}

let stopping = false;
let failures = 0;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    console.log(`[worker] ${signal} received; stopping after the current tick.`);
  });
}

async function main() {
  const { ensureMigrated } = await import("../src/lib/db");
  const { tick } = await import("../src/worker/scheduler");
  await ensureMigrated();
  console.log(`[worker] started with a ${intervalSeconds}s interval`);

  while (!stopping) {
    const startedAt = Date.now();
    try {
      const result = await tick({ now: () => new Date(), source: "persistent-worker" });
      failures = 0;
      console.log(`[worker] ${new Date().toISOString()} ${JSON.stringify(result)}`);
    } catch (error) {
      failures++;
      console.error(`[worker] tick failed (${failures} consecutive):`, error);
    }
    if (stopping) break;
    const normalDelay = Math.max(1_000, intervalSeconds * 1_000 - (Date.now() - startedAt));
    const backoff = failures > 0 ? Math.min(300_000, intervalSeconds * 1_000 * 2 ** Math.min(failures - 1, 4)) : normalDelay;
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }
  console.log("[worker] stopped");
}

main().catch((error) => {
  console.error("[worker] fatal startup failure:", error);
  process.exitCode = 1;
});
