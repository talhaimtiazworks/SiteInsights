/**
 * Postgres repository integration tests. Skipped unless TEST_DATABASE_URL is set, e.g.
 *   TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/sitelens_test npm test
 * WARNING: uses (and writes to) the given database.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config/env";
import { PostgresRepository } from "@/lib/db/postgres";
import { advanceScan, createScanJob } from "@/lib/scanner/engine";
import type { ScanJob } from "@/lib/scanner/types";
import { getEntitlements } from "@/lib/usage/entitlements";
import { consumeUsage } from "@/lib/usage/meter";
import { fixtureLookup, fixturePolicy, startFixtureServer, type FixtureServer } from "./helpers/fixture-server";

const URL_ = process.env.TEST_DATABASE_URL;
const d = URL_ ? describe : describe.skip;

d("PostgresRepository (integration)", () => {
  let repo: PostgresRepository;
  let srv: FixtureServer;
  const principal = randomUUID();

  beforeAll(async () => {
    repo = new PostgresRepository(URL_!, { ssl: "disable", autoMigrate: true });
    srv = await startFixtureServer();
    await repo.ensurePrincipal(principal, "iphash-" + principal);
  });
  afterAll(async () => {
    await srv?.close();
    await repo?.close();
  });

  it("runs a full multi-step scan with persisted state", async () => {
    const s = loadConfig({}).scanner;
    const websiteId = await repo.upsertWebsite(srv.origin, "site.sitelens-fixture.com");
    expect(await repo.upsertWebsite(srv.origin, "site.sitelens-fixture.com")).toBe(websiteId);
    const job = createScanJob({ principalId: principal, websiteId, targetUrl: `${srv.origin}/`, limits: { ...s, hostMinIntervalMs: 0, allowedPorts: [srv.port, 80], stepBudgetMs: 1, requestTimeoutMs: 1500, maxRetries: 0 } });
    await repo.createScan(job);
    let scan: ScanJob | null = null;
    let steps = 0;
    for (; steps < 80; steps++) {
      scan = (await advanceScan(job.id, { repo, userAgent: "t", aiAvailable: false, fetchOverrides: { lookup: fixtureLookup(), addressPolicy: fixturePolicy } })).scan;
      if (scan && !["queued", "running"].includes(scan.status)) break;
    }
    expect(steps).toBeGreaterThan(1);
    expect(scan!.status).toBe("completed");
    expect((await repo.listPages(job.id)).length).toBeGreaterThanOrEqual(5);
    expect((await repo.listLinkChecks(job.id)).some((l) => l.category === "blocked")).toBe(true);
    const findings = await repo.listFindings(job.id);
    expect(findings.length).toBeGreaterThan(10);
    expect(await repo.getFinding(job.id, findings[0].id)).toEqual(findings[0]);
    expect((await repo.listScans(principal, 10)).map((x) => x.id)).toContain(job.id);

    // AI recommendation cache: one row per (scan, finding) — saving again replaces it.
    const base = { scanId: job.id, findingId: findings[0].id, provider: "openrouter" as const, model: "m", fallbackFrom: null, createdAt: new Date().toISOString() };
    await repo.saveAiRecommendation({ ...base, id: randomUUID(), content: { v: 1 } });
    await repo.saveAiRecommendation({ ...base, id: randomUUID(), content: { v: 2 } });
    expect((await repo.getAiRecommendation(job.id, findings[0].id))?.content).toEqual({ v: 2 });
    await repo.saveAiRecommendation({ ...base, findingId: null, id: randomUUID(), content: { summary: true } });
    expect((await repo.getAiRecommendation(job.id, null))?.content).toEqual({ summary: true });
    expect((await repo.listAiRecommendations(job.id)).length).toBe(2);
  }, 60_000);

  it("enforces state transitions and leases atomically", async () => {
    const job = createScanJob({ principalId: principal, websiteId: null, targetUrl: "https://example.com/", limits: loadConfig({}).scanner as never });
    await repo.createScan(job);
    const leases = await Promise.all([repo.acquireLease(job.id, 10_000), repo.acquireLease(job.id, 10_000), repo.acquireLease(job.id, 10_000)]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    await repo.releaseLease(job.id);
    expect(await repo.acquireLease(job.id, 10_000)).toBe(true);
    await repo.releaseLease(job.id);
    expect(await repo.transitionScan(job.id, ["queued", "running"], "cancelled", { finishedAt: new Date().toISOString() })).toBe(true);
    expect(await repo.transitionScan(job.id, ["queued", "running"], "running")).toBe(false);
    expect((await repo.getScan(job.id))?.status).toBe("cancelled");
  });

  it("consumes usage atomically under concurrency and refunds", async () => {
    // AI is a paid feature; PLAN_PRO_AI_PER_DAY sets the Pro allowance.
    const ent = getEntitlements({ id: "x", plan: "pro" }, loadConfig({ PLAN_PRO_AI_PER_DAY: "3" }));
    const ctx = { principalId: principal, ipHash: "iphash-" + principal };
    const results = await Promise.all(Array.from({ length: 10 }, () => consumeUsage(repo, ctx, "ai_request", ent)));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    await repo.refundUsage("ai_request", ctx.principalId, ctx.ipHash);
    expect((await consumeUsage(repo, ctx, "ai_request", ent)).allowed).toBe(true);
  });

  it("concurrent refunds each remove one usage record (no lost refunds)", async () => {
    // Regression: DELETE … WHERE id = (SELECT … LIMIT 1) let parallel refunds pick the same row,
    // so one refund was silently lost and the user stayed charged.
    const owner = randomUUID();
    const ip = "iphash-" + owner;
    await repo.ensurePrincipal(owner, ip);
    const ent = getEntitlements({ id: "x", plan: "free" }, loadConfig({ FREE_SCANS_PER_WINDOW: "50", AUDIT_BURST_LIMIT: "50" }));
    const ctx = { principalId: owner, ipHash: ip };
    for (let i = 0; i < 6; i++) expect((await consumeUsage(repo, ctx, "scan", ent)).allowed).toBe(true);
    const others = [0, 1, 2].map(() => new PostgresRepository(URL_!, { ssl: "disable", autoMigrate: false }));
    try {
      const repos = [repo, ...others];
      await Promise.all(Array.from({ length: 5 }, (_, i) => repos[i % repos.length].refundUsage("scan", owner, ip)));
    } finally {
      await Promise.all(others.map((r) => r.close()));
    }
    const left = await repo.countUsage("scan", owner, ip, new Date(Date.now() - 86_400_000));
    expect(left.byPrincipal).toBe(1);
  });

  it("stores render and performance artifacts per scan, replacing by key", async () => {
    const s = loadConfig({}).scanner;
    const owner = randomUUID(); // separate principal: other tests count this principal's history
    await repo.ensurePrincipal(owner, "iphash-" + owner);
    const job = createScanJob({ principalId: owner, websiteId: null, targetUrl: "https://artifacts.example.com/", limits: { ...s, allowedPorts: [80, 443] } });
    await repo.createScan(job);
    const now = new Date().toISOString();
    await repo.saveArtifact({ id: randomUUID(), scanId: job.id, kind: "render", key: "https://artifacts.example.com/", data: { ok: true, n: 1 }, createdAt: now });
    await repo.saveArtifact({ id: randomUUID(), scanId: job.id, kind: "render", key: "https://artifacts.example.com/", data: { ok: true, n: 2 }, createdAt: now });
    await repo.saveArtifact({ id: randomUUID(), scanId: job.id, kind: "performance", key: "mobile", data: { score: 61, text: "Ünïcödé — ok" }, createdAt: now });
    const renders = await repo.listArtifacts(job.id, "render");
    expect(renders).toHaveLength(1);
    expect(renders[0].data).toEqual({ ok: true, n: 2 });
    expect((await repo.listArtifacts(job.id, "performance"))[0].data).toEqual({ score: 61, text: "Ünïcödé — ok" });
    expect(await repo.listArtifacts(job.id)).toHaveLength(2);
    expect(await repo.listArtifacts(randomUUID(), "render")).toEqual([]);
  });

  it("stores provider preferences (references only) and prunes history", async () => {
    await repo.setProviderPreference(principal, "gemini");
    expect(await repo.getProviderPreference(principal)).toBe("gemini");
    await repo.setProviderPreference(principal, null);
    expect(await repo.getProviderPreference(principal)).toBeNull();
    const removed = await repo.pruneHistory(principal, 1);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect((await repo.listScans(principal, 10)).length).toBe(1);
  });
});
