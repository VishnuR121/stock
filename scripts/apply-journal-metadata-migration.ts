import { readFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { getConfig } from "../server/config";
import { createPostgresClient } from "../server/db/client";

dotenv.config({ path: ".env.local" });
dotenv.config();

async function main() {
  const config = getConfig();
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required to apply database migrations.");
  }

  const migrationPath = path.resolve("drizzle/0002_journal_metadata.sql");
  const sql = await readFile(migrationPath, "utf8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

  const client = createPostgresClient(config.databaseUrl);
  try {
    for (const statement of statements) {
      await client.unsafe(statement);
    }
    console.log(`Applied ${statements.length} journal metadata migration statements.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
