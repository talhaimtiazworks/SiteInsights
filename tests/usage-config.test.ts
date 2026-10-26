import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config/env";
import { MemoryRepository } from "@/lib/db/memory";
import { MIGRATIONS } from "@/lib/db/migrations";
import { ApiError, assertSameOrigin, errorResponse } from "@/lib/http/api";
import { getEntitlements } from "@/lib/usage/entitlements";
import { consumeUsage, peekUsage } from "@/lib/usage/meter";

describe("configuration", () => {
  it("starts with no environment at all (no AI, no database)", () => {
    const c = loadConfig({});
    // Strict BYOK: no AI credential is read from the environment at all.
    expect(JSON.stringify(c.ai)).not.toContain("apiKey");
    expect(c.databaseUrl).toBeNull();
    // Operator hard caps; per-audit limits come from the plan catalog.
    expect(c.scanner.maxPages).toBe(500);
    // Free product: the Free plan carries the full feature set and the generous default page cap.
    expect(c.plans.plans.free.maxPagesPerAudit).toBe(500);
    expect(c.plans.plans.pro.maxPagesPerAudit).toBe(150);
    expect(c.plans.plans.business.maxPagesPerAudit).toBe(500);
    expect(c.plans.plans.free.maxDepth).toBe(8);
    expect(c.billing.provider).toBeNull();
    expect(c.ai.gemini.model).toBe("gemini-flash-latest");
  });

  it("clamps invalid numbers and records warnings instead of crashing", () => {
    const c = loadConfig({ SCAN_MAX_PAGES: "100000", SCAN_MAX_DEPTH: "abc" });
    expect(c.scanner.maxPages).toBeLessThanOrEqual(500);
    // Legacy SCAN_MAX_* variables still configure the Free plan; out-of-range values clamp to the hard cap.
    expect(c.plans.plans.free.maxPagesPerAudit).toBe(500);
    expect(c.plans.plans.free.maxDepth).toBe(8);
    expect(c.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("strict BYOK: legacy owner AI keys are ignored and flagged for removal; only model names are read", () => {
    const c = loadConfig({ OPENROUTER_API_KEY: "k1-owner-key-must-not-be-used", OPENROUTER_MODEL: "x/y", GEMINI_API_KEY: "k2", AI_PROVIDER: "gemini", AI_FALLBACK_ENABLED: "true" });
    expect(c.ai.openrouter).toEqual({ model: "x/y" });
    expect(JSON.stringify(c.ai)).not.toContain("k1-owner-key-must-not-be-used");
    expect(JSON.stringify(c.ai)).not.toContain("k2");
    expect(c.warnings.some((w) => w.includes("OPENROUTER_API_KEY") && w.includes("no longer used"))).toBe(true);
    expect(c.warnings.some((w) => w.includes("AI_PROVIDER") && w.includes("no longer used"))).toBe(true);
    // NEXT_PUBLIC_* key variables are never read either.
    const d = loadConfig({ NEXT_PUBLIC_OPENROUTER_API_KEY: "leak", NEXT_PUBLIC_GEMINI_API_KEY: "leak" });
    expect(JSON.stringify(d.ai)).not.toContain("leak");
  });

  it("no source file references NEXT_PUBLIC_*_API_KEY", async () => {
    const { execSync } = await import("node:child_process");
    const out = execSync(`grep -rEl "NEXT_PUBLIC_[A-Z_]*API_KEY" src || true`, { cwd: path.join(__dirname, "..") }).toString().trim();
    expect(out).toBe("");
  });
});

describe("usage limits", () => {
  const cfg = loadConfig({ FREE_SCANS_PER_WINDOW: "2", FREE_AI_REQUESTS_PER_WINDOW: "3", FREE_IP_LIMIT_MULTIPLIER: "2" });
  const ent = getEntitlements({ id: "p", plan: "free" }, cfg);

  it("allows up to the limit then blocks with a reset time", async () => {
    const repo = new MemoryRepository();
    const ctx = { principalId: "p1", ipHash: "ip1" };
    expect((await consumeUsage(repo, ctx, "scan", ent)).allowed).toBe(true);
    const second = await consumeUsage(repo, ctx, "scan", ent);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);
    const third = await consumeUsage(repo, ctx, "scan", ent);
    expect(third.allowed).toBe(false);
    expect(third.limitedBy).toBe("principal");
    expect(third.resetAt).not.toBeNull();
    const reset = Date.parse(third.resetAt!);
    expect(reset).toBeGreaterThan(Date.now());
    expect(reset).toBeLessThanOrEqual(Date.now() + 86_400_000 + 1000);
  });

  it("cannot be bypassed by clearing cookies: the network allowance still applies", async () => {
    const repo = new MemoryRepository();
    // Same IP hash, new anonymous principal each time (simulates clearing cookies).
    let allowed = 0;
    for (let i = 0; i < 10; i++) if ((await consumeUsage(repo, { principalId: `p${i}`, ipHash: "shared" }, "scan", ent)).allowed) allowed++;
    expect(allowed).toBe(4); // limit 2 × multiplier 2
    const blocked = await consumeUsage(repo, { principalId: "fresh", ipHash: "shared" }, "scan", ent);
    expect(blocked.allowed).toBe(false);
    expect(blocked.limitedBy).toBe("ip");
  });

  it("tracks scans and AI requests separately; peek does not consume; refunds restore allowance", async () => {
    const repo = new MemoryRepository();
    const ctx = { principalId: "p", ipHash: "i" };
    // AI is a paid feature: use Pro entitlements (the Free plan has no AI allowance).
    const ent = getEntitlements({ id: "p", plan: "pro" }, cfg);
    await consumeUsage(repo, ctx, "scan", ent);
    expect((await peekUsage(repo, ctx, "ai_request", ent)).used).toBe(0);
    await consumeUsage(repo, ctx, "ai_request", ent);
    expect((await peekUsage(repo, ctx, "ai_request", ent)).used).toBe(1);
    expect((await peekUsage(repo, ctx, "ai_request", ent)).used).toBe(1);
    await repo.refundUsage("ai_request", ctx.principalId, ctx.ipHash);
    expect((await peekUsage(repo, ctx, "ai_request", ent)).used).toBe(0);
  });
});

describe("migrations", () => {
  it("db/migrations/001_initial.sql matches the embedded migration", () => {
    const file = readFileSync(path.join(__dirname, "..", "db", "migrations", "001_initial.sql"), "utf8");
    expect(MIGRATIONS[0].version).toBe("001_initial");
    expect(file.trim()).toBe(MIGRATIONS[0].sql.trim());
  });
  it("every db/migrations/*.sql file matches an embedded migration, in order", () => {
    const dir = path.join(__dirname, "..", "db", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    expect(files.map((f) => f.replace(/\.sql$/, ""))).toEqual(MIGRATIONS.map((m) => m.version));
    for (const [i, f] of files.entries()) expect(readFileSync(path.join(dir, f), "utf8").trim()).toBe(MIGRATIONS[i].sql.trim());
  });
  it("defines all core tables and no key columns", () => {
    const sql = MIGRATIONS.map((m) => m.sql).join("\n").toLowerCase();
    for (const t of ["principals", "websites", "scans", "scan_pages", "link_checks", "findings", "ai_recommendations", "usage_events", "provider_preferences"]) {
      expect(sql).toContain(`create table if not exists ${t}`);
    }
    expect(sql).not.toMatch(/api_key/);
  });
});

describe("API helpers", () => {
  const req = (headers: Record<string, string>) => new NextRequest("https://app.example.com/api/scans", { method: "POST", headers });
  it("accepts same-origin and proxied-origin requests", () => {
    expect(() => assertSameOrigin(req({ origin: "https://app.example.com", host: "app.example.com" }), null)).not.toThrow();
    expect(() => assertSameOrigin(req({ origin: "https://3000-abc.e2b.app", host: "localhost:3000", "x-forwarded-host": "3000-abc.e2b.app" }), null)).not.toThrow();
    expect(() => assertSameOrigin(req({}), null)).not.toThrow();
  });
  it("rejects cross-site requests", () => {
    expect(() => assertSameOrigin(req({ origin: "https://evil.example", host: "app.example.com" }), null)).toThrow(ApiError);
    expect(() => assertSameOrigin(req({ origin: "https://app.example.com", host: "app.example.com", "sec-fetch-site": "cross-site" }), null)).toThrow(ApiError);
  });
  it("trusts the browser's Sec-Fetch-Site: same-origin behind Host-rewriting proxies", () => {
    expect(() => assertSameOrigin(req({ origin: "https://3000-abc.e2b.app", host: "127.0.0.1:3000", "sec-fetch-site": "same-origin" }), null)).not.toThrow();
  });
  it("never exposes stack traces in error responses", async () => {
    const r = errorResponse(new Error("secret internal detail at /srv/app.js:10"));
    expect(r.status).toBe(500);
    const body = await r.json();
    // Only a random reference id is added (to find the redacted server log entry).
    expect(body).toEqual({ ok: false, error: { code: "internal_error", message: expect.any(String), details: { ref: expect.stringMatching(/^[0-9a-f]{8}$/) } } });
    expect(JSON.stringify(body)).not.toContain("secret internal detail");
    expect(JSON.stringify(body)).not.toContain("/srv/app.js");
  });
});
