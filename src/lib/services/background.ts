import "server-only";
import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { getConfig } from "../config/env";
import { getRepository } from "../db";
import { logger } from "../logger";
import { isTerminal } from "../scans/state-machine";
import { onAuditFinished, runScanStep } from "./scans";
import { settleAuditCreditsSafe } from "../credits/service";
import { isAccountPrincipal } from "../auth/audit-policy";

/**
 * Background audit processing — audits finish even if the browser tab closes.
 *
 * 1. After POST /api/scans (and re-runs) responds, `after()` keeps the same
 *    function invocation working on that audit for up to BACKGROUND_BUDGET_MS.
 * 2. If the audit is still unfinished, it hands over to a fresh invocation by
 *    calling POST /api/internal/process (authenticated with CRON_SECRET), which
 *    does the same — a bounded chain of short invocations, never one long one.
 * 3. A scheduled sweep (Vercel Cron → GET /api/internal/process, also
 *    CRON_SECRET) picks up anything left behind (e.g. after a deploy).
 * An open progress page also advances audits; a lease guarantees only one
 * worker runs a given audit step at a time, so the paths never conflict.
 */

/** Each hop runs ~BACKGROUND_BUDGET_MS; 100 hops cover the largest plan's audit time budget with room for link checks and analysis. */
const MAX_HOPS = 100;
/** Audits older than this are not picked up by the sweep (the engine's own time limit ends them sooner). */
const SWEEP_MAX_AGE_MS = 6 * 60 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function backgroundEnabled(): boolean {
  return process.env.BACKGROUND_PROCESSING?.trim().toLowerCase() !== "false";
}

/** Schedules work to run after the response is sent. Outside a request scope (scripts, tests) it does nothing. */
export function runAfterResponse(task: () => Promise<unknown>): boolean {
  if (!backgroundEnabled()) return false;
  try {
    after(async () => {
      try {
        await task();
      } catch (err) {
        logger.error("Background task failed", err);
      }
    });
    return true;
  } catch {
    return false;
  }
}

/** Advances one audit until it finishes or the time budget is used. Returns true when it reached a final state. */
export async function driveScan(id: string, budgetMs: number): Promise<boolean> {
  const repo = getRepository();
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const scan = await repo.getScan(id);
    if (!scan || isTerminal(scan.status) || !isAccountPrincipal(scan.principalId)) return true;
    const { scan: next, leaseBusy } = await runScanStep(scan, { ipHash: scan.ipHash ?? "background" });
    if (!next || isTerminal(next.status)) return true;
    if (leaseBusy) await sleep(1500); // another worker (or the open tab) holds this step
  }
  return false;
}

/** Hands an unfinished audit to a fresh invocation of this deployment. */
export async function handOff(origin: string, scanId: string, hop: number): Promise<boolean> {
  const cfg = getConfig();
  if (!cfg.background.cronSecret || hop > MAX_HOPS) return false;
  const headers: Record<string, string> = { authorization: `Bearer ${cfg.background.cronSecret}`, "content-type": "application/json" };
  if (cfg.background.bypassSecret) headers["x-vercel-protection-bypass"] = cfg.background.bypassSecret;
  try {
    const res = await fetch(new URL("/api/internal/process", origin), { method: "POST", headers, body: JSON.stringify({ scanId, hop }), signal: AbortSignal.timeout(10_000), redirect: "manual" });
    if (res.status !== 202) logger.warn("Background hand-off was not accepted", { status: res.status });
    return res.status === 202;
  } catch (err) {
    logger.warn("Background hand-off failed", err instanceof Error ? err.message : "unknown");
    return false;
  }
}

/**
 * How audits progress without an open tab:
 *  - "full": serverless with CRON_SECRET (hand-off chain), or a long-running
 *    server (keeps working in-process until the audit ends).
 *  - "limited": serverless without CRON_SECRET — the first ~BACKGROUND_BUDGET_MS
 *    run after the request; then the audit continues only while its page is
 *    open (the sweep endpoint refuses requests without CRON_SECRET).
 *  - "off": BACKGROUND_PROCESSING=false.
 */
export function backgroundMode(): "full" | "limited" | "off" {
  if (!backgroundEnabled()) return "off";
  const cfg = getConfig();
  return cfg.background.cronSecret || !cfg.storage.serverless ? "full" : "limited";
}

/** Starts background processing for a just-created audit (after the response). */
export function processInBackground(origin: string, scanId: string, hop = 0) {
  return runAfterResponse(async () => {
    const cfg = getConfig();
    let current = scanId;
    let currentHop = hop;
    // Bounded: one audit plus the owner's queued batch audits that start as each one ends.
    for (let n = 0; n < 25; n++) {
      const done = await driveScan(current, cfg.background.budgetMs);
      if (!done) {
        if (await handOff(origin, current, currentHop + 1)) return;
        // Long-running servers (not serverless) can simply keep going in-process.
        if (cfg.storage.serverless) return;
        const scan = await getRepository().getScan(current);
        if (scan) await driveScan(current, Math.max(60_000, scan.limits.maxDurationMs + 60_000));
      }
      // A finished audit may have started the owner's next queued batch audit: keep it moving.
      const next = await nextActiveAudit(current);
      if (!next) return;
      if (await handOff(origin, next, 0)) return;
      if (cfg.storage.serverless) return; // the sweep or an open page continues it
      current = next;
      currentHop = 0;
    }
  });
}

/** Scheduled sweep: advances the oldest runnable audits within the time budget. */
export async function sweep(budgetMs: number): Promise<{ processed: number; finished: number; settled: number; stalled: number; batchStarted: number }> {
  const repo = getRepository();
  const deadline = Date.now() + budgetMs;
  let processed = 0;
  let finished = 0;
  const { settled, stalled } = await reconcileCredits().catch((err) => {
    logger.warn("Credit reconciliation failed", err);
    return { settled: 0, stalled: 0 };
  });
  const { sweepBatchQueues } = await import("./batches");
  const batchStarted = await sweepBatchQueues().catch(() => 0);
  const seen = new Set<string>();
  while (Date.now() < deadline) {
    const batch = (await repo.listRunnableScans(5, SWEEP_MAX_AGE_MS)).filter((s) => !seen.has(s.id) && isAccountPrincipal(s.principalId));
    if (!batch.length) break;
    for (const s of batch) {
      if (Date.now() >= deadline) break;
      seen.add(s.id);
      processed++;
      if (await driveScan(s.id, Math.min(deadline - Date.now(), budgetMs))) finished++;
    }
  }
  return { processed, finished, settled, stalled, batchStarted };
}

/** Audits that have not progressed for this long are ended as stalled and fully refunded. */
const STALLED_AFTER_MS = SWEEP_MAX_AGE_MS + 30 * 60_000;
/** Reservations younger than this may belong to an audit that is still being created. */
const RESERVATION_SETTLE_MIN_AGE_MS = 10 * 60_000;

/**
 * Settles credit reservations whose audit ended (or disappeared) without being
 * settled — e.g. after a crash between the final step and settlement — and
 * ends audits that stalled beyond the processing window. Idempotent.
 */
export async function reconcileCredits(limit = 50): Promise<{ settled: number; stalled: number }> {
  const repo = getRepository();
  let settled = 0;
  let stalled = 0;
  for (const r of await repo.commerce.listUnsettledReservations(limit)) {
    const age = Date.now() - Date.parse(r.createdAt);
    if (age < RESERVATION_SETTLE_MIN_AGE_MS) continue;
    const scan = await repo.getScan(r.auditId);
    if (scan && !isTerminal(scan.status)) {
      if (age < STALLED_AFTER_MS) continue;
      const ended = await repo.transitionScan(scan.id, ["queued", "running"], "failed", { error: { code: "stalled", message: "The audit stopped making progress and was ended. Its credits were refunded." }, finishedAt: new Date().toISOString(), phase: "finished" });
      if (ended) stalled++;
      const res = await settleAuditCreditsSafe(repo, { principalId: r.principalId, auditId: r.auditId }, await repo.getScan(scan.id), { stalled: true });
      if (res?.settled) settled++;
      continue;
    }
    if (scan) {
      await onAuditFinished(repo, scan);
      settled++;
    } else if ((await settleAuditCreditsSafe(repo, { principalId: r.principalId, auditId: r.auditId }, null))?.settled) settled++;
  }
  return { settled, stalled };
}

/** The owner's next queued/running audit other than `finishedId` (e.g. a batch item that just started). */
export async function nextActiveAudit(finishedId: string): Promise<string | null> {
  const repo = getRepository();
  const finished = await repo.getScan(finishedId);
  if (!finished) return null;
  const mine = await repo.listScans(finished.principalId, 10);
  return mine.find((s) => s.id !== finishedId && !isTerminal(s.status))?.id ?? null;
}

/** Constant-time check of "Authorization: Bearer <CRON_SECRET>". */
export function isAuthorizedCron(authorization: string | null): boolean {
  const secret = getConfig().background.cronSecret;
  if (!secret || !authorization?.startsWith("Bearer ")) return false;
  const a = Buffer.from(authorization.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
