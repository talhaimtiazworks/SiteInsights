#!/usr/bin/env node
// Audited operator tool for plan changes while no payment provider is integrated
// (or for support corrections later). Requires direct database access — there is
// deliberately no HTTP endpoint for this.
//
// Every change is written in ONE transaction together with a billing_events row
// (provider "manual", unique event id, operator reason), so it is auditable and
// cannot be applied twice. Credits are granted automatically by the app on the
// account's next request (new subscription period ⇒ new credit period).
//
// Usage:
//   DATABASE_URL=postgres://… node scripts/billing/manage-subscription.mjs show  --user <uuid|email>
//   DATABASE_URL=postgres://… node scripts/billing/manage-subscription.mjs grant --user <uuid|email> --plan pro|business --months 1 --reason "…" --confirm
//   DATABASE_URL=postgres://… node scripts/billing/manage-subscription.mjs end   --user <uuid|email> --reason "…" --confirm
//
// `end` ends MANUAL subscriptions immediately. Provider-managed subscriptions must
// be cancelled in the provider's dashboard so the verified webhook updates them.
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = rest[i + 1];
  if (next === undefined || next.startsWith("--")) args[key] = true;
  else {
    args[key] = next;
    i++;
  }
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!["show", "grant", "end"].includes(cmd ?? "")) die("Usage: manage-subscription.mjs show|grant|end --user <uuid|email> [--plan pro|business --months N] --reason \"…\" --confirm");
if (typeof args.user !== "string") die("--user <uuid|email> is required.");
if (cmd !== "show") {
  if (args.confirm !== true) die("Refusing to change anything without --confirm.");
  if (typeof args.reason !== "string" || args.reason.trim().length < 5) die("--reason \"…\" (at least 5 characters) is required for the audit log.");
}

const names = ["MIGRATION_DATABASE_URL", "POSTGRES_URL_NON_POOLING", "DATABASE_URL_UNPOOLED", "DATABASE_URL", "POSTGRES_URL"];
const name = names.find((n) => process.env[n]?.trim());
if (!name) die(`No database URL found. Set one of: ${names.join(", ")}.`);
const u = new URL(process.env[name].trim());
for (const p of ["supa", "pgbouncer", "connection_limit", "pool_timeout", "schema", "statement_cache_size"]) u.searchParams.delete(p);
const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
const sslEnv = (process.env.DATABASE_SSL || "").toLowerCase();
const ssl = sslEnv === "disable" ? false : sslEnv || (local || u.searchParams.has("sslmode") ? undefined : "require");
const sql = postgres(u.toString(), { ssl, max: 1, prepare: false, onnotice: () => {} });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const operator = process.env.USER || process.env.USERNAME || "unknown";

try {
  const [profile] = UUID.test(args.user) ? await sql`SELECT id, email FROM profiles WHERE id = ${args.user}` : await sql`SELECT id, email FROM profiles WHERE lower(email) = lower(${args.user})`;
  if (!profile) die("No SiteInsights profile found for that user (the user must have signed in at least once).");

  if (cmd === "show") {
    const subs = await sql`SELECT id, plan_id, status, provider, provider_reference, current_period_start, current_period_end, cancel_at_period_end, ended_at FROM subscriptions WHERE user_id = ${profile.id} ORDER BY created_at DESC LIMIT 10`;
    const [credits] = await sql`SELECT plan_id, balance, allowance, period_key, period_end FROM credit_accounts WHERE principal_id = ${"user:" + profile.id}`;
    console.log(JSON.stringify({ user: profile, subscriptions: subs, credits: credits ?? null }, null, 2));
  } else if (cmd === "grant") {
    if (!["pro", "business"].includes(args.plan)) die("--plan must be pro or business.");
    const months = Number(args.months ?? 1);
    if (!Number.isInteger(months) || months < 1 || months > 12) die("--months must be an integer between 1 and 12.");
    const result = await sql.begin(async (tx) => {
      const eventId = `manual:${randomUUID()}`;
      const now = new Date();
      const end = new Date(now);
      end.setUTCMonth(end.getUTCMonth() + months);
      // End every other live subscription first (one live subscription per user).
      await tx`UPDATE subscriptions SET status = 'canceled', ended_at = ${now}, current_period_end = LEAST(current_period_end, ${now}), updated_at = now()
               WHERE user_id = ${profile.id} AND status IN ('trialing','active','past_due')`;
      const subId = randomUUID();
      const ref = `manual:${profile.id}:${now.toISOString()}`;
      await tx`INSERT INTO subscriptions (id, user_id, plan_id, status, provider, provider_reference, current_period_start, current_period_end, cancel_at_period_end, last_event_at)
               VALUES (${subId}, ${profile.id}, ${args.plan}, 'active', 'manual', ${ref}, ${now}, ${end}, true, ${now})`;
      await tx`INSERT INTO billing_events (id, provider, event_id, event_type, user_id, subscription_id, occurred_at, outcome, detail)
               VALUES (${randomUUID()}, 'manual', ${eventId}, 'subscription.activated', ${profile.id}, ${subId}, ${now}, 'applied',
                       ${sql.json({ plan: args.plan, months, reason: args.reason.trim(), operator })})`;
      return { eventId, subscriptionId: subId, plan: args.plan, periodEnd: end.toISOString() };
    });
    console.log(`Granted ${result.plan} until ${result.periodEnd} (no auto-renewal). Event ${result.eventId}. Credits are granted on the user's next request.`);
  } else {
    const result = await sql.begin(async (tx) => {
      const now = new Date();
      const ended = await tx`UPDATE subscriptions SET status = 'canceled', ended_at = ${now}, current_period_end = LEAST(current_period_end, ${now}), cancel_at_period_end = false, updated_at = now(), last_event_at = ${now}
                             WHERE user_id = ${profile.id} AND provider = 'manual' AND status IN ('trialing','active','past_due') RETURNING id, plan_id`;
      for (const s of ended) {
        await tx`INSERT INTO billing_events (id, provider, event_id, event_type, user_id, subscription_id, occurred_at, outcome, detail)
                 VALUES (${randomUUID()}, 'manual', ${"manual:" + randomUUID()}, 'subscription.expired', ${profile.id}, ${s.id}, ${now}, 'applied', ${sql.json({ reason: args.reason.trim(), operator })})`;
      }
      return ended;
    });
    console.log(result.length ? `Ended ${result.length} manual subscription(s). The account is on Free from its next request; history is kept for 30 days at the previous limit.` : "No live manual subscription found. Provider subscriptions must be cancelled at the provider.");
  }
} finally {
  await sql.end({ timeout: 5 });
}
