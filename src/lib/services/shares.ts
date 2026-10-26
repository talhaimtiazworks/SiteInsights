import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getConfig } from "../config/env";
import { getRepository, maybeAccountRepository } from "../db";
import type { ReportShare } from "../db/commerce-types";
import { ApiError } from "../http/api";
import type { RequestContext } from "../http/context";
import { hasResults } from "../scans/state-machine";
import type { ScanJob } from "../scanner/types";
import type { ClientReportSnapshot } from "../report/snapshot-types";
import { cleanText } from "./prospects";
import { buildClientReportSnapshotContent } from "./client-reports";
import { entitlementsForPrincipal } from "./plan";
import { loadOwnedScan } from "./scans";

/**
 * Client share links: a read-only, expiring, revocable URL to
 * one finished audit report and its PDF. The token is 256 random bits; only
 * its SHA-256 is stored. Links stop working when revoked, when they expire,
 * when the audit is deleted, or when the owner no longer has the feature.
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const hashShareToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const MAX_SHARE_DAYS = 90;

export function publicShare(s: ReportShare) {
  return { id: s.id, label: s.label, allowPdf: s.allowPdf, snapshotVersion: s.snapshotVersion ?? null, createdAt: s.createdAt, expiresAt: s.expiresAt, revokedAt: s.revokedAt, lastViewedAt: s.lastViewedAt, viewCount: s.viewCount, active: !s.revokedAt && Date.parse(s.expiresAt) > Date.now() };
}

async function ownerWithFeature(ctx: RequestContext, auditId: string) {
  const repo = getRepository();
  const scan = await loadOwnedScan(repo, auditId, ctx);
  const ent = await entitlementsForPrincipal(scan.principalId);
  return { repo, scan, ent };
}

export async function createShare(ctx: RequestContext, auditId: string, input: { expiresInDays?: number; label?: string | null; allowPdf?: boolean }, origin: string) {
  const { repo, scan, ent } = await ownerWithFeature(ctx, auditId);
  if (!ent.features.shareLinks) throw new ApiError(403, "feature_unavailable", "Report share links are disabled on this deployment.", { feature: "shareLinks" });
  if (!hasResults(scan.status)) throw new ApiError(409, "results_unavailable", "Only finished audits can be shared.");
  const days = Math.min(MAX_SHARE_DAYS, Math.max(1, Math.floor(input.expiresInDays ?? 30)));
  if (!ctx.user || scan.principalId !== ctx.principalId) throw new ApiError(403, "owner_required", "Only the signed-in audit owner can create a client report snapshot.");
  const accounts = maybeAccountRepository();
  if (accounts) await accounts.ensureProfile({ id: ctx.user.id, email: ctx.user.email, displayName: ctx.user.displayName });
  const content = await buildClientReportSnapshotContent(repo, accounts, ctx.user.id, scan);
  const snapshot = await repo.commerce.createReportSnapshot(ctx.user.id, scan.id, content);
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const share: ReportShare = {
    id: randomUUID(),
    principalId: scan.principalId,
    auditId: scan.id,
    snapshotId: snapshot.id,
    snapshotVersion: snapshot.version,
    tokenHash: hashShareToken(token),
    label: cleanText(input.label ?? null, 120),
    allowPdf: input.allowPdf !== false && ent.features.pdfExport,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
    revokedAt: null,
    lastViewedAt: null,
    viewCount: 0,
  };
  try {
    await repo.commerce.createReportShare(share);
  } catch (err) {
    await repo.commerce.deleteReportSnapshot(ctx.user.id, snapshot.id).catch(() => {});
    throw err;
  }
  // The full URL is returned exactly once; it cannot be recovered later.
  return { share: publicShare(share), url: `${(getConfig().appUrl ?? origin).replace(/\/$/, "")}/r/${token}` };
}

export async function listShares(ctx: RequestContext, auditId: string) {
  const { repo, scan, ent } = await ownerWithFeature(ctx, auditId);
  return { shares: (await repo.commerce.listReportShares(scan.principalId, scan.id)).map(publicShare), available: ent.features.shareLinks };
}

export async function revokeShare(ctx: RequestContext, auditId: string, shareId: string) {
  const { repo, scan } = await ownerWithFeature(ctx, auditId);
  const mine = (await repo.commerce.listReportShares(scan.principalId, scan.id)).some((s) => s.id === shareId);
  if (!mine || !(await repo.commerce.revokeReportShare(scan.principalId, shareId))) throw new ApiError(404, "not_found", "Share link not found or already revoked.");
}

/** Resolves a public token to its audit. Identical 404 for malformed, unknown, expired, revoked or downgraded links. */
export async function resolveShare(token: string): Promise<{ share: ReportShare; scan: ScanJob; snapshot: ClientReportSnapshot | null }> {
  const notFound = new ApiError(404, "not_found", "This report link is invalid, has expired or was revoked.");
  if (!TOKEN_RE.test(token)) throw notFound;
  const repo = getRepository();
  const share = await repo.commerce.useReportShare(hashShareToken(token));
  if (!share) throw notFound;
  const scan = await repo.getScan(share.auditId);
  if (!scan || scan.principalId !== share.principalId || !hasResults(scan.status)) throw notFound;
  const ent = await entitlementsForPrincipal(share.principalId);
  if (!ent.features.shareLinks) throw notFound;
  let snapshot: ClientReportSnapshot | null = null;
  if (share.snapshotId) {
    const userId = share.principalId.startsWith("user:") ? share.principalId.slice(5) : "";
    if (!userId) throw notFound;
    snapshot = await repo.commerce.getReportSnapshot(userId, share.snapshotId);
    if (!snapshot || snapshot.auditId !== scan.id || snapshot.userId !== userId || snapshot.content?.schemaVersion !== 1 || snapshot.content.scan?.id !== scan.id) throw notFound;
    share.snapshotVersion = snapshot.version;
  }
  return { share, scan, snapshot };
}
