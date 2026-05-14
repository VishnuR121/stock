import { readFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { getConfig } from "../server/config";
import { createPostgresClient } from "../server/db/client";

dotenv.config({ path: ".env.local" });
dotenv.config();

type MigrationEntry = {
  idx: number;
  tag: string;
};

type MigrationJournal = {
  entries: MigrationEntry[];
};

const EXISTING_SCHEMA_BASELINE_IDX = 1;

async function main() {
  const config = getConfig();
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required to apply database migrations.");
  }

  const migrations = await loadMigrationEntries();
  const client = createPostgresClient(config.databaseUrl);

  try {
    await client.unsafe(`
      CREATE TABLE IF NOT EXISTS "app_migrations" (
        "id" text PRIMARY KEY,
        "applied_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);

    const applied = new Set(await getAppliedMigrationIds(client));
    if (applied.size === 0 && (await hasExistingSchema(client))) {
      const baseline = migrations.filter((entry) => entry.idx <= EXISTING_SCHEMA_BASELINE_IDX);
      for (const entry of baseline) {
        await markApplied(client, entry.tag);
        applied.add(entry.tag);
      }
      if (baseline.length) {
        console.log(`Bootstrapped ${baseline.length} existing-schema migrations.`);
      }
    }

    let appliedCount = 0;
    for (const migration of migrations) {
      if (applied.has(migration.tag)) continue;
      await applyMigration(client, migration);
      appliedCount += 1;
    }

    console.log(appliedCount ? `Applied ${appliedCount} migrations.` : "Database migrations are already up to date.");
  } finally {
    await client.end();
  }
}

async function loadMigrationEntries(): Promise<MigrationEntry[]> {
  const journalPath = path.resolve("drizzle/meta/_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as MigrationJournal;
  return [...journal.entries].sort((a, b) => a.idx - b.idx);
}

async function getAppliedMigrationIds(client: ReturnType<typeof createPostgresClient>): Promise<string[]> {
  const rows = await client<{ id: string }[]>`SELECT "id" FROM "app_migrations"`;
  return rows.map((row) => row.id);
}

async function hasExistingSchema(client: ReturnType<typeof createPostgresClient>): Promise<boolean> {
  const rows = await client<{ has_schema: boolean }[]>`
    SELECT to_regclass('public.journal_entries') IS NOT NULL AS "has_schema"
  `;
  return Boolean(rows[0]?.has_schema);
}

async function applyMigration(client: ReturnType<typeof createPostgresClient>, migration: MigrationEntry): Promise<void> {
  const migrationPath = path.resolve("drizzle", `${migration.tag}.sql`);
  const sql = await readFile(migrationPath, "utf8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

  await client.begin(async (transaction) => {
    for (const statement of statements) {
      await transaction.unsafe(statement);
    }
    await transaction`INSERT INTO "app_migrations" ("id") VALUES (${migration.tag}) ON CONFLICT ("id") DO NOTHING`;
  });

  console.log(`Applied ${migration.tag} (${statements.length} statements).`);
}

async function markApplied(client: ReturnType<typeof createPostgresClient>, id: string): Promise<void> {
  await client`INSERT INTO "app_migrations" ("id") VALUES (${id}) ON CONFLICT ("id") DO NOTHING`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
