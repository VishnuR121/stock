import { createDb } from "./db/client";
import { DatabaseStore } from "./db/store";
import { MemoryStore, type AppStore } from "./storage";
import type { AppConfig } from "./config";

export function createStore(config: AppConfig): AppStore {
  if (config.databaseUrl) {
    return new DatabaseStore(createDb(config.databaseUrl));
  }

  if (process.env.NODE_ENV === "test") {
    return new MemoryStore();
  }

  throw new Error("DATABASE_URL is required. Runtime JSON storage is disabled; configure Postgres/Supabase storage.");
}

export function getStoreDescription(config: AppConfig): string {
  if (config.databaseUrl) return "postgres";
  if (process.env.NODE_ENV === "test") return "memory";
  return "missing_database_url";
}
