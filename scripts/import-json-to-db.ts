import dotenv from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { getConfig } from "../server/config";
import { createPostgresClient } from "../server/db/client";
import { DatabaseStore } from "../server/db/store";
import * as schema from "../server/db/schema";
import { JsonStore } from "../server/storage";

dotenv.config({ path: ".env.local" });
dotenv.config();

async function main() {
  const config = getConfig();
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required to import JSON data into Postgres.");
  }

  const jsonStore = new JsonStore(config.dataFilePath);
  const data = await jsonStore.read();
  console.log(
    `Preparing import from ${config.dataFilePath}: ${data.watchlist.length} watchlist items, ${Object.keys(data.savedPlans).length} AI plans, ${data.journal.length} journal entries, ${data.scanHistory.length} scan runs.`
  );

  const client = createPostgresClient(config.databaseUrl);
  const db = drizzle(client, { schema });

  try {
    const dbStore = new DatabaseStore(db);
    console.log("Writing data to Postgres...");
    await dbStore.write(data);
    console.log("Closing database connection...");
    console.log(
      `Imported ${data.watchlist.length} watchlist items, ${Object.keys(data.savedPlans).length} AI plans, ${data.journal.length} journal entries, and ${data.scanHistory.length} scan runs.`
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
