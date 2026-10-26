/**
 * Audit recovery: a transient database outage in the middle of a step must
 * leave the audit resumable (never "failed"), and an audit deleted while it is
 * being processed must stop quietly. Uses the real engine + memory repository
 * with injected database errors, against the local fixture site.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config/env";
import { MemoryRepository } from "@/lib/db/memory";
import type { Repository } from "@/lib/db/types";
import { advanceScan, createScanJob } from "@/lib/scanner/engine";
import type { ScanLimits } from "@/lib/scanner/types";
import { fixtureLookup, fixturePolicy, startFixtureServer, type FixtureServer } from "./helpers/fixture-server";

let srv: FixtureServer;
const SAFE = new Set(["getScan", "acquireLease", "releaseLease", "createScan", "kind", "persistent"]);

function limits(port: number): ScanLimits {
  const s = loadConfig({}).scanner;
  return {
    maxPages: 5, maxDepth: s.maxDepth, maxRedirects: s.maxRedirects, concurrency: 2, requestTimeoutMs: 1500, maxBodyBytes: s.maxBodyBytes,
    maxDurationMs: 60_000, maxRetries: 0, hostMinIntervalMs: 0, maxLinksToCheck: 20, stepBudgetMs: 1, allowedPorts: [port, 80],
    maxQueryVariantsPerPath: 3, maxSitemapFiles: 2, maxSitemapUrls: 50,
  };
}

/** Repository whose writes throw `error` while `armed` (optionally deleting the audit first). */
function faulty(inner: MemoryRepository, error: () => Error, onFail?: () => Promise<void>) {
  const state = { armed: true, thrown: 0 };
  const repo = new Proxy(inner, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function" || SAFE.has(String(prop))) return typeof v === "function" ? v.bind(target) : v;
      return async (...args: unknown[]) => {
        if (state.armed) {
          state.armed = false;
          state.thrown++;
          await onFail?.();
          throw error();
        }
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as Repository;
  return { repo, state };
}

const deps = (repo: Repository) => ({ repo, userAgent: "SiteLensAI-test/1.0", aiAvailable: false, fetchOverrides: { lookup: fixtureLookup(), addressPolicy: fixturePolicy } });
const TERMINAL = ["completed", "completed_with_warnings", "failed", "cancelled"];

beforeAll(async () => {
  srv = await startFixtureServer();
});
afterAll(async () => {
  await srv?.close();
});

describe("audit recovery", () => {
  it("a connection drop mid-step pauses the audit; the next attempt resumes and completes it", async () => {
    const mem = new MemoryRepository();
    const job = createScanJob({ principalId: "p", websiteId: null, targetUrl: `${srv.origin}/`, limits: limits(srv.port) });
    await mem.createScan(job);
    const { repo, state } = faulty(mem, () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    await expect(advanceScan(job.id, deps(repo))).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(state.thrown).toBe(1);
    const paused = await mem.getScan(job.id);
    expect(["queued", "running"]).toContain(paused!.status); // not "failed"
    expect(paused!.error).toBeNull();
    let status = paused!.status as string;
    for (let i = 0; i < 80 && !TERMINAL.includes(status); i++) status = (await advanceScan(job.id, deps(repo))).scan!.status;
    expect(["completed", "completed_with_warnings"]).toContain(status);
  }, 60_000);

  it("an audit deleted while a step is running stops quietly (no failure written, nothing recreated)", async () => {
    const mem = new MemoryRepository();
    const job = createScanJob({ principalId: "p", websiteId: null, targetUrl: `${srv.origin}/`, limits: limits(srv.port) });
    await mem.createScan(job);
    const { repo } = faulty(
      mem,
      () => Object.assign(new Error('insert or update on table "audit_artifacts" violates foreign key constraint'), { code: "23503", constraint_name: "scan_artifacts_scan_id_fkey" }),
      async () => {
        await mem.deleteScan(job.id);
      },
    );
    const res = await advanceScan(job.id, deps(repo));
    expect(res).toEqual({ scan: null, leaseBusy: false });
    expect(await mem.getScan(job.id)).toBeNull();
  });

  it("other errors still mark the audit failed with a safe message", async () => {
    const mem = new MemoryRepository();
    const job = createScanJob({ principalId: "p", websiteId: null, targetUrl: `${srv.origin}/`, limits: limits(srv.port) });
    await mem.createScan(job);
    const { repo } = faulty(mem, () => new TypeError("boom"));
    const res = await advanceScan(job.id, deps(repo));
    expect(res.scan!.status).toBe("failed");
    expect(res.scan!.error).toMatchObject({ code: "internal_error" });
    expect(JSON.stringify(res.scan!.error)).not.toContain("boom");
  });
});
