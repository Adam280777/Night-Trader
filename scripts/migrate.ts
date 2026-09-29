// Applies database migrations. Runs before dev/start/build so the schema is always current.
import { config } from "dotenv";
config({ path: ".env.local" });
config();

async function main() {
  const { ensureMigrated } = await import("../src/lib/db");
  await ensureMigrated({ force: true });
  console.log("Database is up to date.");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
