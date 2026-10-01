// Runs one scheduler tick locally (same code the /api/cron/tick endpoint runs).
import { config } from "dotenv";
config({ path: ".env.local" });
config();

async function main() {
  const { ensureMigrated } = await import("../src/lib/db");
  const { tick } = await import("../src/worker/scheduler");
  await ensureMigrated();
  console.log(await tick({ now: () => new Date(), source: "manual" }));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
