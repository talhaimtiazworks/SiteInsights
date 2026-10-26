import "server-only";
import { randomUUID } from "node:crypto";
import { isAccountPrincipal } from "../auth/audit-policy";

import { getConfig } from "../config/env";

import { getRepository } from "../db";
import type { AuditBatch, BatchItem } from "../db/commerce-types";
import { ApiError } from "../http/api";
import type { RequestContext } from "../http/context";
import { logger } from "../logger";
import { validatePublicUrl } from "../security/url";
import { entitlementsForPrincipal } from "./plan";
import { ACTIVE_WINDOW_MS, startScan } from "./scans";

/**
 * Batch audits — available to every signed-in user in the free product.
 *
 * A batch is a queue of up to `maxBatchSize` URLs submitted in one verified,
 * signed-in request. Items start one after another, never exceeding the
 * concurrent-audit safeguard. Each item goes through the normal `startScan`
 * path (URL + DNS safety checks, page limit, abuse limits), so a batch cannot
 * bypass anything a single audit is subject to. Items that cannot start are
 * marked skipped with the reason.
 */

export interface BatchSubmission {
  urls: string[];
  maxPages?: number | null;
}

export async function createBatch(ctx: RequestContext, input: BatchSubmission) {
  const repo = getRepository();
  const ent = await entitlementsForPrincipal(ctx.principalId);
  if (!ent.features.batchAudits || ent.maxBatchSize <= 0) {
    throw new ApiError(403, "feature_unavailable", "Batch audits are disabled on this deployment.", { feature: "batchAudits" });
  }
  const cfg = getConfig();
  const seen = new Set<string>();
  const urls: string[] = [];
  const rejected: Array<{ url: string; reason: string }> = [];
  for (const raw of input.urls.map((u) => u.trim()).filter(Boolean)) {
    const v = validatePublicUrl(raw, { allowedPorts: cfg.scanner.allowedPorts });
    if (!v.ok) {
      rejected.push({ url: raw.slice(0, 200), reason: v.message });
      continue;
    }
    if (seen.has(v.url.hostname)) continue; // one audit per site per batch
    seen.add(v.url.hostname);
    urls.push(v.normalized);
  }
  if (rejected.length) throw new ApiError(400, "invalid_batch_urls", `${rejected.length} URL(s) are not valid public website addresses.`, { rejected });
  if (!urls.length) throw new ApiError(400, "empty_batch", "Add at least one website URL.");
  if (urls.length > ent.maxBatchSize) throw new ApiError(400, "batch_too_large", `A batch can contain up to ${ent.maxBatchSize} websites.`, { maxBatchSize: ent.maxBatchSize });
  const maxPages = input.maxPages ?? ent.maxPagesPerScan;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > ent.maxPagesPerScan) {
    throw new ApiError(403, "page_limit_exceeded", `Audits are limited to ${ent.maxPagesPerScan} pages for this deployment.`, { maxPagesPerAudit: ent.maxPagesPerScan });
  }
  await repo.ensurePrincipal(ctx.principalId, ctx.ipHash);
  const now = new Date().toISOString();
  const batch: AuditBatch = {
    id: randomUUID(),
    principalId: ctx.principalId,
    ipHash: ctx.ipHash,
    createdAt: now,
    items: urls.map((url, i): BatchItem => ({ id: randomUUID(), batchId: "", principalId: ctx.principalId, position: i, url, maxPages, status: "pending", auditId: null, error: null, createdAt: now, updatedAt: now })),
  };
  batch.items.forEach((i) => (i.batchId = batch.id));
  await repo.commerce.createBatch(batch);
  const started = await pumpBatchQueue(ctx.principalId, ctx.ipHash, ctx);
  return { batch: (await repo.commerce.getBatch(ctx.principalId, batch.id))!, started, maxCost: 0 };
}

/**
 * Starts pending batch items while the owner has free concurrency slots.
 * Called after a batch is created, whenever an audit finishes, and by the
 * scheduled sweep. Safe to call concurrently: items are claimed atomically and
 * startScan re-checks the concurrency limit after inserting.
 */
export async function pumpBatchQueue(principalId: string, ipHash: string | null, requestCtx?: RequestContext): Promise<string[]> {
  if (!isAccountPrincipal(principalId)) return [];
  const repo = getRepository();
  const ent = await entitlementsForPrincipal(principalId);
  const started: string[] = [];
  // Owner context for an item the owner already authorised with a verified session.
  const ctx: RequestContext = requestCtx ?? {
    principalId,
    anonymousPrincipalId: principalId,
    ipHash: ipHash ?? "batch",
    isNewPrincipal: false,
    scanKey: null,
    user: { id: principalId.slice(5), email: null, sessionMethod: null, providers: [], isSso: false, displayName: null, avatarUrl: null },
    auth: "signed_in",
  };
  for (let guard = 0; guard < 20; guard++) {
    const active = await repo.countActiveScans({ principalId, activeSince: new Date(Date.now() - ACTIVE_WINDOW_MS) });
    if (active >= ent.maxConcurrentScans) break;
    const item = await repo.commerce.claimNextBatchItem(principalId);
    if (!item) break;
    if (!ent.features.batchAudits) {
      await repo.commerce.updateBatchItem(item.id, { status: "skipped", error: "Batch audits were disabled before this audit started." });
      continue;
    }
    try {
      const { scan } = await startScan(ctx, item.url, { idempotencyKey: `batch_${item.id.replace(/-/g, "")}`.slice(0, 64), maxPages: Math.min(item.maxPages, ent.maxPagesPerScan), trustedOwner: !requestCtx });
      await repo.commerce.updateBatchItem(item.id, { status: "started", auditId: scan.id, error: null });
      started.push(scan.id);
    } catch (err) {
      if (err instanceof ApiError && err.code === "concurrent_scan_limit") {
        await repo.commerce.updateBatchItem(item.id, { status: "pending" }); // a slot was taken concurrently: retry later
        break;
      }
      if (err instanceof ApiError && (err.code === "capacity_reached" || err.code === "scan_burst_limited")) {
        await repo.commerce.updateBatchItem(item.id, { status: "pending" });
        break;
      }
      const message = err instanceof ApiError ? err.message : "The audit could not be started because of an internal error.";
      if (!(err instanceof ApiError)) logger.warn("Batch audit failed to start", err);
      await repo.commerce.updateBatchItem(item.id, { status: err instanceof ApiError && err.status === 402 ? "skipped" : "failed", error: message.slice(0, 500) });
    }
  }
  return started;
}

export async function sweepBatchQueues(limit = 20) {
  const repo = getRepository();
  const owners = await repo.commerce.listPrincipalsWithPendingBatchItems(limit);
  let started = 0;
  for (const o of owners) started += (await pumpBatchQueue(o.principalId, o.ipHash).catch(() => [])).length;
  return started;
}
