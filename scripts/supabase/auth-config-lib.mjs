/**
 * Pure helpers for scripts/supabase/configure-auth.mjs (unit-tested in
 * tests/supabase-auth-config.test.ts). Field names follow the Management API
 * "Update auth config" reference: PATCH /v1/projects/{ref}/config/auth.
 */

/** Project ref from SUPABASE_PROJECT_REF or a https://<ref>.supabase.co URL. */
export function projectRef(env) {
  if (env.SUPABASE_PROJECT_REF) {
    if (!/^[a-z0-9]{20}$/.test(env.SUPABASE_PROJECT_REF)) throw new Error("SUPABASE_PROJECT_REF must be the 20-character project ref (Project Settings → General).");
    return env.SUPABASE_PROJECT_REF;
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
  const m = url ? /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url.trim()) : null;
  if (!m) throw new Error("Set SUPABASE_PROJECT_REF (or NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co).");
  return m[1];
}

export function normalizeOrigin(raw) {
  const u = new URL(raw);
  if (u.username || u.password) throw new Error("--app-url must not contain credentials");
  if (u.protocol !== "https:") throw new Error("--app-url must be an https:// origin");
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname)) throw new Error("--app-url must be the public production origin, not a local address");
  return u.origin;
}

/** Keeps every existing entry, adds the required ones; comma-separated as the API expects. */
export function mergeAllowList(current, add) {
  const items = (current ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const a of add) if (!items.includes(a)) items.push(a);
  return items.join(",");
}

export function redirectUrlsFor(appUrl, { previewPattern, localhost = true } = {}) {
  const list = [`${appUrl}/**`];
  if (previewPattern) list.push(previewPattern);
  if (localhost) list.push("http://localhost:3000/**");
  return list;
}

// Security notifications whose template key differs from the enable flag.
const NOTIFICATION_FLAG = {
  password_changed_notification: "mailer_notifications_password_changed_enabled",
  email_changed_notification: "mailer_notifications_email_changed_enabled",
  identity_linked_notification: "mailer_notifications_identity_linked_enabled",
  identity_unlinked_notification: "mailer_notifications_identity_unlinked_enabled",
};

/**
 * templates: { key: { subject, html } }. Auth templates are always included;
 * notification templates only with notifications=true (which also enables them).
 */
export function templatePatch(templates, { notifications = false } = {}) {
  const patch = {};
  for (const [key, t] of Object.entries(templates)) {
    const flag = NOTIFICATION_FLAG[key];
    if (flag && !notifications) continue;
    patch[`mailer_subjects_${key}`] = t.subject;
    patch[`mailer_templates_${key}_content`] = t.html;
    if (flag) patch[flag] = true;
  }
  return patch;
}

// SMTP delivery belongs to Supabase Auth; the operator adapter validates Mailjet settings.
export { mailjetSmtpPatch } from "../email/smtp-config.mjs";

const SECRET_FIELDS = new Set(["smtp_pass", "smtp_user", "smtp_admin_email"]);

/** Human-readable diff that never contains secrets or full template bodies. */
export function describeChanges(current, patch) {
  const lines = [];
  for (const [k, v] of Object.entries(patch)) {
    const before = current?.[k];
    const same = before === v;
    let shown;
    if (SECRET_FIELDS.has(k)) shown = "(secret from environment)";
    else if (k === "uri_allow_list") shown = `${String(v).split(",").filter(Boolean).length} redirect entries (existing entries preserved)`;
    else if (k.endsWith("_content")) shown = `${String(v).length} chars of branded HTML`;
    else shown = JSON.stringify(v);
    lines.push(`${same ? "  unchanged" : "  change   "} ${k} = ${shown}`);
  }
  return lines;
}
