import "server-only";
import { getConfig } from "../config/env";
import { logger } from "../logger";
import { DatabaseProblemError } from "./errors";
import { MemoryRepository } from "./memory";
import { PostgresRepository } from "./postgres";
import type { AccountRepository } from "./account-types";
import type { Repository } from "./types";

const g = globalThis as unknown as { __sitelensRepo?: Repository; __sitelensMemoryStore?: ReturnType<typeof MemoryRepository.emptyStore> };

/**
 * Thrown when no durable storage is configured on a deployment where the
 * in-memory store cannot work (serverless hosting, or production without
 * ALLOW_MEMORY_STORAGE=true). Mapped to HTTP 503 `storage_not_configured`.
 */
export class StorageNotConfiguredError extends Error {
  constructor() {
    super("No database is configured for this deployment.");
  }
}

export type StorageMode = "postgres" | "memory" | "unconfigured";

export interface StorageInfo {
  mode: StorageMode;
  persistent: boolean;
  /** True when audits can be started and read. */
  ready: boolean;
  serverless: boolean;
}

/**
 * Storage policy (single source of truth):
 *  - DATABASE_URL or POSTGRES_URL (Supabase ↔ Vercel integration) set → PostgreSQL. If unreachable, requests fail with 503
 *    `database_unavailable`. There is NO fallback to memory.
 *  - DATABASE_URL unset and memory allowed (development, tests, or a single
 *    long-running server with ALLOW_MEMORY_STORAGE=true) → in-memory store,
 *    labelled non-persistent in the UI.
 *  - Otherwise (e.g. Vercel without a database) → StorageNotConfiguredError.
 *    In-memory storage on serverless hosting loses scans between requests
 *    because each instance has its own memory.
 */
export function storageInfo(): StorageInfo {
  const cfg = getConfig();
  if (cfg.databaseUrl) return { mode: "postgres", persistent: true, ready: true, serverless: cfg.storage.serverless };
  // Set but unusable: still "postgres" (never a silent fallback to memory), but not ready.
  if (cfg.databaseUrlInvalid) return { mode: "postgres", persistent: true, ready: false, serverless: cfg.storage.serverless };
  if (cfg.storage.allowMemory) return { mode: "memory", persistent: false, ready: true, serverless: cfg.storage.serverless };
  return { mode: "unconfigured", persistent: false, ready: false, serverless: cfg.storage.serverless };
}

export function getRepository(): Repository {
  if (g.__sitelensRepo) return g.__sitelensRepo;
  const cfg = getConfig();
  const info = storageInfo();
  if (info.mode === "postgres") {
    const variable = cfg.databaseUrlSource ?? cfg.databaseUrlInvalid ?? "DATABASE_URL";
    if (!cfg.databaseUrl) throw misconfigured(variable, "invalid_connection_string");
    try {
      g.__sitelensRepo = new PostgresRepository(cfg.databaseUrl, { ssl: cfg.dbSsl, autoMigrate: cfg.dbAutoMigrate, migrationUrl: cfg.migrationDatabaseUrl });
    } catch (err) {
      // The driver parses the URL synchronously here. Never let that escape as an
      // unclassified 500 (the cause of "Something went wrong on our side" on every
      // database request); the failure is not cached, so a fixed variable works after redeploy.
      throw misconfigured(variable, err instanceof Error ? err.name : "constructor_failed");
    }
  } else if (info.mode === "memory") {
    g.__sitelensMemoryStore ??= MemoryRepository.emptyStore();
    g.__sitelensRepo = new MemoryRepository(g.__sitelensMemoryStore);
  } else {
    throw new StorageNotConfiguredError();
  }
  return g.__sitelensRepo;
}

let reported = false;
function misconfigured(variable: string, reason: string) {
  const e = new DatabaseProblemError("database_misconfigured", { variable, reason });
  if (!reported) {
    reported = true; // once per instance; no values, only the variable name
    logger.error(`Database client could not be created from ${variable} (${reason}). Copy the transaction pooler connection string again from Supabase → Connect and URL-encode special characters in the password. /api/system/status → configIssues names the exact problem.`);
  }
  return e;
}

/** Thrown when an account feature is used without a PostgreSQL database. Mapped to 503 accounts_need_database. */
export class AccountsNeedDatabaseError extends Error {
  constructor() {
    super("Accounts require a PostgreSQL database.");
  }
}

/** Account data (profiles, settings, organizations, subscriptions) — PostgreSQL only. */
export function getAccountRepository(): AccountRepository {
  const repo = getRepository();
  if (repo.kind !== "postgres") throw new AccountsNeedDatabaseError();
  return repo as unknown as AccountRepository;
}

/** Account repository if available (PostgreSQL), else null. */
export function maybeAccountRepository(): AccountRepository | null {
  try {
    return getAccountRepository();
  } catch {
    return null;
  }
}

/** Test helper: forget the cached repository (simulates a fresh server instance). */
export function __resetRepositoryForTests(opts: { keepMemory?: boolean } = {}) {
  delete g.__sitelensRepo;
  if (!opts.keepMemory) delete g.__sitelensMemoryStore;
}

export { DatabaseUnavailableError } from "./postgres";
export { DuplicateScanError } from "./types";
