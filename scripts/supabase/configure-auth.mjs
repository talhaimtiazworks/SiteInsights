#!/usr/bin/env node
/**
 * Explicit operator setup of the EXISTING Supabase Auth project; dry run by default.
 * --smtp: Mailjet SMTP_USER / SMTP_PASS / EMAIL_FROM (+ SMTP_HOST/PORT/SECURE).
 * --urls: set Site URL and MERGE redirects; requires a verified --app-url.
 * --templates / --notifications: preserve the existing branded template pipeline.
 * --apply: save settings. Never run automatically during a build or API request.
 * See docs/MAILJET-SMTP.md. SMTP-only changes never change URLs, providers or limits.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SmtpConfigurationError } from "../email/smtp-config.mjs";
import { describeChanges, mailjetSmtpPatch, mergeAllowList, normalizeOrigin, projectRef, redirectUrlsFor, templatePatch } from "./auth-config-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
class AuthSetupError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export async function runConfigureAuth({ argv = process.argv.slice(2), env = process.env, fetchImpl = fetch, output = console.log, errorOutput = console.error } = {}) {
  try {
    const flags = new Set(["--smtp", "--urls", "--templates", "--notifications", "--no-localhost", "--apply", "--help"]);
    const options = new Set(["--app-url", "--preview-pattern"]);
    const values = {};
    const selected = new Set();
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (selected.has(flag)) throw new AuthSetupError("invalid_arguments", "Repeated setup flags are not accepted.");
      selected.add(flag);
      if (options.has(flag)) {
        if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new AuthSetupError("invalid_arguments", "A setup option is missing its value.");
        values[flag] = argv[++i];
      } else if (!flags.has(flag)) throw new AuthSetupError("invalid_arguments", "Unknown setup flag. Use --help; credentials belong only in the environment.");
    }
    const flag = (name) => selected.has(name);
    if (flag("--help")) {
      output("SiteInsight Auth setup: --smtp | --urls | --templates | --notifications [--app-url verified-origin] [--preview-pattern pattern] [--no-localhost] [--apply]. Dry run by default. Mailjet details: docs/MAILJET-SMTP.md.");
      return 0;
    }
    if (!["--smtp", "--urls", "--templates", "--notifications"].some(flag)) throw new AuthSetupError("invalid_arguments", "Choose at least one of --smtp, --urls, --templates or --notifications.");

    // Validate SMTP BEFORE any network access. Never fall back to old provider credentials.
    const patch = flag("--smtp") ? mailjetSmtpPatch(env) : {};
    let appUrl;
    if (flag("--urls") || flag("--templates") || flag("--notifications")) {
      const raw = values["--app-url"] ?? env.NEXT_PUBLIC_APP_URL;
      if (raw) {
        try { appUrl = normalizeOrigin(raw); }
        catch { throw new AuthSetupError("invalid_app_url", "Use a verified public https:// origin for --app-url; local addresses and credentials in URLs are not allowed."); }
      } else if (flag("--urls")) throw new AuthSetupError("invalid_app_url", "--urls requires a verified public --app-url (or NEXT_PUBLIC_APP_URL).");
    }
    if (!env.SUPABASE_ACCESS_TOKEN?.trim()) throw new AuthSetupError("missing_management_token", "Set SUPABASE_ACCESS_TOKEN privately for this operator command; it is not the publishable or service key.");
    let ref;
    try { ref = projectRef(env); }
    catch { throw new AuthSetupError("invalid_project", "Set a valid SUPABASE_PROJECT_REF, or the existing Supabase project's public URL."); }

    if (flag("--templates") || flag("--notifications")) {
      const meta = JSON.parse(await readFile(path.join(root, "supabase/templates/subjects.json"), "utf8"));
      if (meta.appUrl !== "{{ .SiteURL }}" && meta.appUrl !== appUrl) throw new AuthSetupError("template_origin_mismatch", "Pinned email templates do not match --app-url. Use the verified origin or rebuild the templates; do not change live URLs to bypass this check.");
      const templates = {};
      for (const [key, subject] of Object.entries(meta.subjects)) templates[key] = { subject, html: await readFile(path.join(root, "supabase/templates", `${key}.html`), "utf8") };
      const templateFields = templatePatch(templates, { notifications: flag("--notifications") });
      if (!flag("--templates")) for (const key of Object.keys(templateFields)) if (!/notification|mailer_notifications_/.test(key)) delete templateFields[key];
      Object.assign(patch, templateFields);
    }

    let apiBase = "https://api.supabase.com";
    if (env.CONFIGURE_AUTH_API_BASE) {
      let testBase;
      try { testBase = new URL(env.CONFIGURE_AUTH_API_BASE); } catch { /* reject below without echoing input */ }
      if (env.NODE_ENV !== "test" || !testBase || testBase.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(testBase.hostname) || testBase.username || testBase.password) throw new AuthSetupError("unsafe_api_override", "The Management API override is only allowed for a loopback HTTP test stub under NODE_ENV=test.");
      apiBase = testBase.origin;
    }
    const api = `${apiBase}/v1/projects/${ref}/config/auth`;
    const headers = { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "content-type": "application/json" };
    async function request(method, fields) {
      let response;
      try {
        response = await fetchImpl(api, { method, headers, redirect: "error", ...(fields ? { body: JSON.stringify(fields) } : {}), signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new AuthSetupError("auth_settings_rejected", `Auth settings request was rejected (HTTP ${response.status}). Review the project and access rights privately; provider response details are not logged.`);
        if (method === "GET") {
          const data = await response.json();
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new AuthSetupError("invalid_management_response", "The Auth settings response was not valid. No secret response body is logged.");
          return data;
        }
        await response.body?.cancel();
        return undefined;
      } catch (error) {
        if (error instanceof AuthSetupError) throw error;
        const timeout = ["AbortError", "TimeoutError"].includes(error?.name);
        throw new AuthSetupError(timeout ? "auth_settings_timeout" : "auth_settings_unavailable", method === "PATCH"
          ? "The Auth settings update could not be confirmed. Check the Supabase dashboard before another manual attempt; the update may already have applied. No automatic retry was made."
          : "Auth settings could not be read within the request limit. Check the project, token and network privately. No provider exception details are logged.");
      }
    }

    const current = await request("GET");
    if (flag("--urls")) {
      patch.site_url = appUrl;
      patch.uri_allow_list = mergeAllowList(current.uri_allow_list, redirectUrlsFor(appUrl, { previewPattern: values["--preview-pattern"], localhost: !flag("--no-localhost") }));
    }
    output(`Project ${ref} — ${flag("--apply") ? "applying explicitly" : "dry run (add --apply to save)"}:`);
    for (const line of describeChanges(current, patch)) output(line);
    if (!flag("--apply")) return 0;
    await request("PATCH", patch); // Exactly one write: never retry an ambiguous update.
    const after = await request("GET");
    const mismatched = Object.keys(patch).filter((key) => !["smtp_pass", "smtp_user"].includes(key) && String(after[key]) !== String(patch[key]));
    if (mismatched.length) throw new AuthSetupError("auth_settings_readback_mismatch", "The update was accepted but non-secret read-back fields differ. Inspect the dashboard before retrying; no email delivery is verified.");
    output("Saved and read back successfully. No email was sent; SMTP authentication and inbox delivery remain unverified.");
    return 0;
  } catch (error) {
    if (error instanceof SmtpConfigurationError || error instanceof AuthSetupError) errorOutput(`${error.code}: ${error.message}`);
    else errorOutput("auth_setup_failed: Setup could not be completed. Check the local template files and configuration privately. No raw exception, credentials or provider response is logged.");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runConfigureAuth();
