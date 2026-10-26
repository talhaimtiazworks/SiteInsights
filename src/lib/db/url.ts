/**
 * Preparation of PostgreSQL connection strings for the `postgres` driver.
 *
 * Why this exists (production incident behind "Something went wrong on our
 * side" on every database-backed endpoint):
 * the driver parses the URL synchronously when the client is created and runs
 * `decodeURIComponent` on the user name and password (postgres.js 3.4.x,
 * `parseUrl`). A password containing a `%` that is not a valid `%XX` escape —
 * e.g. `50%off` or `abc%` — is accepted by WHATWG `new URL()` (our previous
 * validation) but makes the driver throw `URIError: URI malformed`. That
 * happened in `getRepository()`, outside every error classifier, so each
 * request returned an unclassified HTTP 500 within ~200 ms.
 *
 * This module never logs or returns the URL's credentials. Issues name the
 * variable only.
 */
import type { ConfigIssue } from "../config/consistency";

/** Query parameters added by the Supabase integration / Prisma that the driver would forward as server settings. */
const STRIP_PARAMS = ["supa", "pgbouncer", "connection_limit", "pool_timeout", "schema", "statement_cache_size"];
const PLACEHOLDER = /^\[?\s*(your[-_ ]?password|password|your-db-password|db[-_]password)\s*\]?$/i;
const STRAY_PERCENT = /%(?![0-9A-Fa-f]{2})/g;

export interface PreparedDatabaseUrl {
  /** Driver-safe URL, or null when the value is not a usable postgres:// URL. */
  url: string | null;
  issues: ConfigIssue[];
}

function decodes(s: string): boolean {
  try {
    decodeURIComponent(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirrors the URL handling of postgres.js `parseUrl` (3.4.x) without
 * connecting: true when creating a client with this URL cannot throw.
 */
export function driverAcceptsUrl(url: string): boolean {
  try {
    let host = url.slice(url.indexOf("://") + 3).split(/[?/]/)[0];
    host = decodeURIComponent(host.slice(host.indexOf("@") + 1));
    const u = new URL(url.replace(host, host.split(",")[0]));
    decodeURIComponent(u.username);
    decodeURIComponent(u.password);
    return true;
  } catch {
    return false;
  }
}

export function prepareDatabaseUrl(raw: string, variable: string): PreparedDatabaseUrl {
  const issues: ConfigIssue[] = [];
  let value = raw.trim();
  // A value pasted with its surrounding quotes from a .env file.
  const quoted = /^(["'])(.*)\1$/s.exec(value);
  if (quoted) {
    value = quoted[2].trim();
    issues.push({ severity: "warning", variables: [variable], problem: `${variable} is wrapped in quotes.`, fix: `Remove the surrounding quotes from ${variable} in Vercel → Settings → Environment Variables (they are used as-is). The app strips them for now.` });
  }
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    issues.push({ severity: "error", variables: [variable], problem: `${variable} is not a valid postgres:// connection string.`, fix: invalidUrlFix(variable) });
    return { url: null, issues };
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    issues.push({ severity: "error", variables: [variable], problem: `${variable} must start with postgres:// or postgresql://.`, fix: `Copy the connection string again from Supabase → Connect → Transaction pooler into ${variable}.` });
    return { url: null, issues };
  }
  for (const p of STRIP_PARAMS) u.searchParams.delete(p);

  // A literal "%" that isn't a %XX escape can only mean a percent sign: encode it
  // exactly as the operator should have. Unambiguous, and the credential is unchanged.
  let repaired = false;
  if (!decodes(u.password)) {
    u.password = u.password.replace(STRAY_PERCENT, "%25");
    repaired = true;
  }
  if (!decodes(u.username)) {
    u.username = u.username.replace(STRAY_PERCENT, "%25");
    repaired = true;
  }
  if (repaired) {
    issues.push({
      severity: "warning",
      variables: [variable],
      problem: `The password (or user) in ${variable} contains a "%" that is not URL-encoded. The database driver cannot parse such a URL, which made every database request fail with "Something went wrong on our side".`,
      fix: `URL-encode special characters in the password inside ${variable}: % → %25, @ → %40, # → %23, / → %2F, ? → %3F, : → %3A. SiteInsights now encodes a stray "%" automatically, but fix the variable so other tools (npm run db:migrate, psql) work too.`,
    });
  }
  let password = "";
  try {
    password = decodeURIComponent(u.password);
  } catch {
    /* handled below by driverAcceptsUrl */
  }
  if (PLACEHOLDER.test(password)) {
    issues.push({ severity: "error", variables: [variable], problem: `${variable} still contains the placeholder password from the Supabase "Connect" dialog.`, fix: `Replace [YOUR-PASSWORD] in ${variable} with the database password (Supabase → Project Settings → Database → Reset database password if you don't know it), URL-encoding special characters.` });
  }
  const url = u.toString();
  if (!driverAcceptsUrl(url)) {
    issues.push({ severity: "error", variables: [variable], problem: `${variable} cannot be parsed by the database driver.`, fix: invalidUrlFix(variable) });
    return { url: null, issues };
  }
  return { url, issues };
}

function invalidUrlFix(variable: string) {
  return `Copy the connection string again from Supabase → Connect → Transaction pooler into ${variable}, replace [YOUR-PASSWORD] with the database password and URL-encode its special characters (% → %25, @ → %40, # → %23, / → %2F, ? → %3F).`;
}
