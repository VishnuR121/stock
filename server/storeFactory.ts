import { createDb } from "./db/client";
import { DatabaseStore } from "./db/store";
import { JsonStore, type AppStore } from "./storage";
import type { AppConfig } from "./config";

export function createStore(config: AppConfig): AppStore {
  if (config.databaseUrl) {
    return new DatabaseStore(createDb(config.databaseUrl));
  }

  return new JsonStore(config.dataFilePath);
}

export function getStoreDescription(config: AppConfig): string {
  return config.databaseUrl ? "postgres" : config.dataFilePath;
}
