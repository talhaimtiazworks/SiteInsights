import type { NextRequest } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config/env";
import { getAccountRepository, getRepository } from "@/lib/db";
import { ApiError, assertSameOrigin, assertScanId, ok, readJson, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { loadOwnedScan, loadScanAccess, onAuditFinished, toPublicScan } from "@/lib/services/scans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Audit status & progress (owner or current member of its explicitly shared organization). */
export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  const { id } = await params;
  assertScanId(id);
  throttle(req, ctx);
  const { scan, viewer } = await loadScanAccess(getRepository(), id, ctx, "read");
  return ok(toPublicScan(scan, viewer));
});

const patchSchema = z
  .object({
    title: z.string().trim().max(120).nullable().optional(),
    organizationId: z.uuid().nullable().optional(),
    /** Compare-and-set value prevents a stale tab from silently overwriting a newer share choice. */
    expectedOrganizationId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.organizationId !== undefined, { message: "Nothing to update." })
  .refine((v) => v.organizationId === undefined || v.expectedOrganizationId !== undefined, {
    message: "Share changes must include the current organization value.",
    path: ["expectedOrganizationId"],
  });

/** Rename an audit, or explicitly share/unshare it with one of your organizations. Owner only. */
export const PATCH = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  const { id } = await params;
  assertScanId(id);
  throttle(req, ctx);
  const body = patchSchema.parse(await readJson(req));
  const repo = getRepository();
  const scan = await loadOwnedScan(repo, id, ctx);
  const patch: { title?: string | null; organizationId?: string | null } = {};
  if (body.title !== undefined) patch.title = body.title ? body.title : null;
  if (body.organizationId !== undefined) {
    if (!ctx.user || scan.principalId !== ctx.principalId) throw new ApiError(403, "account_required", "Only audits saved to your account can be shared with an organization.");
    if (body.organizationId) {
      const role = await getAccountRepository().getMembership(body.organizationId, ctx.user.id);
      if (!role) throw new ApiError(404, "organization_not_found", "Organization not found.");
    }
    patch.organizationId = body.organizationId;
  }
  const updated = await repo.updateScanMeta(id, patch, {
    principalId: ctx.principalId,
    ...(body.organizationId !== undefined
      ? {
          expectedOrganizationId: body.expectedOrganizationId,
          ...(body.organizationId ? { organizationMemberUserId: ctx.user.id } : {}),
        }
      : {}),
  });
  if (!updated) {
    const current = await repo.getScan(id);
    if (!current || current.principalId !== ctx.principalId) throw new ApiError(404, "not_found", "Audit not found.");
    if (body.organizationId !== undefined && (current.organizationId ?? null) !== body.expectedOrganizationId) {
      throw new ApiError(409, "audit_sharing_conflict", "This audit's sharing changed in another session. Refresh the audit and try again.");
    }
    if (body.organizationId && !(await getAccountRepository().getMembership(body.organizationId, ctx.user.id))) {
      throw new ApiError(404, "organization_not_found", "Organization not found.");
    }
    throw new ApiError(409, "audit_update_conflict", "The audit changed while you were saving. Refresh and try again.");
  }
  const saved = await repo.getScan(id);
  if (!saved) throw new ApiError(404, "not_found", "Audit not found.");
  return ok(toPublicScan(saved));
});

/** Permanently deletes an audit and all of its results. Owner only. A running audit is cancelled first. */
export const DELETE = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  const { id } = await params;
  assertScanId(id);
  throttle(req, ctx);
  const repo = getRepository();
  await loadOwnedScan(repo, id, ctx);
  await repo.transitionScan(id, ["queued", "running"], "cancelled", { finishedAt: new Date().toISOString(), phase: "finished", error: { code: "cancelled", message: "The audit was deleted." } });
  // Settle credits before the audit's pages disappear (idempotent if already settled).
  const final = await repo.getScan(id);
  if (final) await onAuditFinished(repo, final);
  const deleted = await repo.deleteScan(id);
  if (!deleted) throw new ApiError(404, "not_found", "Audit not found.");
  return ok({ deleted: true, id });
});
