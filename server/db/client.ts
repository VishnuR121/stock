import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createPostgresClient(databaseUrl: string) {
  return postgres(databaseUrl, {
    max: 5,
    idle_timeout: 5,
    connect_timeout: 15,
    prepare: false
  });
}

export function createDb(databaseUrl: string) {
  const client = createPostgresClient(databaseUrl);
  return drizzle(client, { schema });
}

export type AppDb = ReturnType<typeof createDb>;
