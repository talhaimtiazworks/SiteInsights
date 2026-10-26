import "server-only";
import { z } from "zod";
import { getConfig } from "../config/env";
import { getRepository, maybeAccountRepository } from "../db";
import { PROSPECT_STATUSES, type Prospect, type ProspectPatch, type ProspectStatus } from "../db/commerce-types";
import { ApiError } from "../http/api";
import type { RequestContext } from "../http/context";
import { buildProspectEvidence, prospectsToCsv } from "../leads/opportunity";
import { parseProspectCsv } from "../leads/prospect-import";
import { validatePublicUrl } from "../security/url";
import { hasResults } from "../scans/state-machine";
import { dashboardAccess, memberOrgIds } from "./dashboard";
import { entitlementsForPrincipal } from "./plan";
import { loadOwnedScan } from "./scans";

/** Owner-held prospects are private unless shared with a current organization member. */

/** Removes control characters (except newline/tab) and trims. Output is always rendered as text, never HTML. */
export function cleanText(v: string | null | undefined, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "").trim();
  return s ? s.slice(0, max) : null;
}

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "Enter a full http(s) URL.");

export const manualProspectSchema = z.object({
  websiteUrl: z.string().trim().min(1).max(2048),
  businessName: z.string().max(160).nullable().optional(),
  location: z.string().max(160).nullable().optional(),
}).strict();

export const prospectPatchSchema = z
  .object({
    status: z.enum(PROSPECT_STATUSES).optional(),
    notes: z.string().max(4000).nullable().optional(),
    businessName: z.string().max(160).nullable().optional(),
    location: z.string().max(160).nullable().optional(),
    contactName: z.string().max(120).nullable().optional(),
    contactEmail: z.union([z.email().max(254), z.literal(""), z.null()]).optional(),
    contactUrl: z.union([httpUrl, z.literal(""), z.null()]).optional(),
    organizationId: z.uuid().nullable().optional(),
    assignedToUserId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update." });

function presentProspect(p: Prospect, principalId: string) {
  const { principalId: ownerPrincipalId, ...visible } = p;
  return { ...visible, canManageSharing: ownerPrincipalId === principalId, canDelete: ownerPrincipalId === principalId };
}

async function access(ctx: RequestContext, mode: "read" | "write") {
  const principalId = await dashboardAccess(ctx);
  const ent = await entitlementsForPrincipal(principalId);
  if (mode === "write" && !ent.features.prospects) {
    throw new ApiError(403, "feature_unavailable", "The prospect list is disabled on this deployment.", { feature: "prospects" });
  }
  return { principalId, ent };
}

export async function saveProspectFromAudit(ctx: RequestContext, auditId: string) {
  const { principalId, ent } = await access(ctx, "write");
  const repo = getRepository();
  const scan = await loadOwnedScan(repo, auditId, ctx);
  if (!hasResults(scan.status) || !scan.summary) throw new ApiError(409, "results_unavailable", "Only finished audits can be saved as prospects.");
  const host = new URL(scan.targetUrl).hostname;
  const existing = await repo.commerce.findProspectByHostname(principalId, host);
  if (!existing && (await repo.commerce.countProspects(principalId)) >= ent.maxProspects) {
    throw new ApiError(403, "prospect_limit_reached", `Your plan stores up to ${ent.maxProspects} prospects. Delete some to add more.`, { limit: ent.maxProspects });
  }
  const findings = await repo.listFindings(scan.id);
  const evidence = buildProspectEvidence(scan, findings);
  const result = await repo.commerce.upsertProspect(principalId, {
    hostname: host,
    websiteUrl: new URL(scan.targetUrl).origin + "/",
    auditId: scan.id,
    evidence,
    auditedAt: scan.finishedAt ?? scan.createdAt,
  });
  return { ...result, prospect: presentProspect(result.prospect, principalId) };
}

export async function saveManualProspect(ctx: RequestContext, raw: z.infer<typeof manualProspectSchema>) {
  const input = manualProspectSchema.parse(raw);
  const { principalId, ent } = await access(ctx, "write");
  const valid = validatePublicUrl(input.websiteUrl, { allowedPorts: getConfig().scanner.allowedPorts });
  if (!valid.ok) throw new ApiError(400, "invalid_prospect_url", valid.message, { reason: valid.reason });
  const hostname = valid.url.hostname.toLowerCase();
  const repo = getRepository();
  const existing = await repo.commerce.findProspectByHostname(principalId, hostname);
  if (!existing && (await repo.commerce.countProspects(principalId)) >= ent.maxProspects) {
    throw new ApiError(403, "prospect_limit_reached", `Your plan stores up to ${ent.maxProspects} prospects. Delete some to add more.`, { limit: ent.maxProspects });
  }
  const result = await repo.commerce.upsertProspect(principalId, {
    hostname,
    websiteUrl: `${valid.url.origin}/`,
    auditId: null,
    evidence: null,
    auditedAt: null,
    ...(input.businessName !== undefined ? { businessName: cleanText(input.businessName, 160) } : {}),
    ...(input.location !== undefined ? { location: cleanText(input.location, 160) } : {}),
  });
  return { ...result, prospect: presentProspect(result.prospect, principalId) };
}

/** Validates every row before writing; imports only owner-supplied URLs and never queries a discovery provider. */
export async function importManualProspects(ctx: RequestContext, csv: string) {
  const { principalId, ent } = await access(ctx, "write");
  let parsed;
  try { parsed = parseProspectCsv(csv, 100); }
  catch (err) { throw new ApiError(400, "invalid_prospect_csv", err instanceof Error ? err.message : "The CSV file is invalid."); }
  const cfg = getConfig();
  const issues: Array<{ row: number; message: string }> = [];
  const normalized: Array<{ row: number; hostname: string; websiteUrl: string; businessName: string | null; location: string | null }> = [];
  for (const item of parsed) {
    const valid = validatePublicUrl(item.website, { allowedPorts: cfg.scanner.allowedPorts });
    if (!valid.ok) { issues.push({ row: item.row, message: valid.message }); continue; }
    normalized.push({ row: item.row, hostname: valid.url.hostname.toLowerCase(), websiteUrl: `${valid.url.origin}/`, businessName: cleanText(item.businessName, 160), location: cleanText(item.location, 160) });
  }
  if (issues.length) throw new ApiError(400, "invalid_prospect_csv_rows", "Fix the invalid URLs before importing; no rows were saved.", { issues: issues.slice(0, 20), totalIssues: issues.length });
  const unique = [...new Map(normalized.map((row) => [row.hostname, row])).values()];
  const repo = getRepository();
  const existing = await Promise.all(unique.map((row) => repo.commerce.findProspectByHostname(principalId, row.hostname)));
  const newCount = existing.filter((p) => !p).length;
  if ((await repo.commerce.countProspects(principalId)) + newCount > ent.maxProspects) {
    throw new ApiError(403, "prospect_limit_reached", `This import would exceed your plan's limit of ${ent.maxProspects} prospects. No rows were saved.`, { limit: ent.maxProspects, newProspects: newCount });
  }
  let created = 0;
  let updated = 0;
  for (const row of unique) {
    const result = await repo.commerce.upsertProspect(principalId, {
      hostname: row.hostname,
      websiteUrl: row.websiteUrl,
      auditId: null,
      evidence: null,
      auditedAt: null,
      businessName: row.businessName,
      location: row.location,
    });
    if (result.created) created++; else updated++;
  }
  return { imported: unique.length, created, updated, duplicatesSkipped: normalized.length - unique.length };
}

export async function listProspects(ctx: RequestContext, q: { status?: ProspectStatus | "all"; search?: string | null; limit?: number; offset?: number }) {
  const { principalId, ent } = await access(ctx, "read");
  const organizationIds = await memberOrgIds(ctx);
  const res = await getRepository().commerce.listProspects({ principalId, userId: ctx.user?.id ?? null, organizationIds, status: q.status ?? "all", search: cleanText(q.search, 200), limit: Math.min(200, Math.max(1, q.limit ?? 50)), offset: Math.max(0, q.offset ?? 0) });
  return { ...res, items: res.items.map((p) => presentProspect(p, principalId)), canEdit: ent.features.prospects, limit: ent.maxProspects };
}

export async function getProspect(ctx: RequestContext, id: string) {
  const { principalId } = await access(ctx, "read");
  const organizationIds = await memberOrgIds(ctx);
  const p = await getRepository().commerce.getProspect(principalId, id, organizationIds, ctx.user?.id ?? null);
  if (!p) throw new ApiError(404, "not_found", "Prospect not found.");
  return presentProspect(p, principalId);
}

export async function updateProspect(ctx: RequestContext, id: string, body: z.infer<typeof prospectPatchSchema>) {
  const { principalId } = await access(ctx, "write");
  const repo = getRepository();
  const organizationIds = await memberOrgIds(ctx);
  const actorUserId = ctx.user?.id ?? null;
  const current = await repo.commerce.getProspect(principalId, id, organizationIds, actorUserId);
  if (!current) throw new ApiError(404, "not_found", "Prospect not found.");
  const isPrincipalOwner = current.principalId === principalId;

  if (body.organizationId !== undefined) {
    if (!isPrincipalOwner) throw new ApiError(403, "forbidden", "Only the prospect owner can share or unshare it.");
    if (body.organizationId && !organizationIds.includes(body.organizationId)) throw new ApiError(403, "forbidden", "You must be a current member of that team to share this prospect.");
  }

  const targetOrganizationId = body.organizationId !== undefined ? body.organizationId : current.organizationId;
  if (body.assignedToUserId !== undefined && body.assignedToUserId !== null && !targetOrganizationId) {
    throw new ApiError(400, "assignment_requires_team", "Assign the prospect to a team before choosing a teammate.");
  }
  if (body.assignedToUserId !== undefined && targetOrganizationId) {
    const accounts = maybeAccountRepository();
    if (!actorUserId || !accounts) throw new ApiError(403, "forbidden", "Team membership is required for assignments.");
    const role = await accounts.getMembership(targetOrganizationId, actorUserId);
    if (!role) throw new ApiError(403, "forbidden", "You are no longer a member of this team.");
    if (!isPrincipalOwner && role !== "owner" && role !== "admin") throw new ApiError(403, "forbidden", "Only team owners and admins can change prospect assignments.");
    if (body.assignedToUserId && !(await accounts.getMembership(targetOrganizationId, body.assignedToUserId))) {
      throw new ApiError(400, "invalid_assignee", "Choose a current member of the selected team.");
    }
  }

  const patch: ProspectPatch = {};
  if (body.status !== undefined) patch.status = body.status;
  if (body.notes !== undefined) patch.notes = cleanText(body.notes, 4000);
  if (body.businessName !== undefined) patch.businessName = cleanText(body.businessName, 160);
  if (body.location !== undefined) patch.location = cleanText(body.location, 160);
  if (body.contactName !== undefined) patch.contactName = cleanText(body.contactName, 120);
  if (body.contactEmail !== undefined) patch.contactEmail = body.contactEmail ? body.contactEmail.trim().toLowerCase() : null;
  if (body.contactUrl !== undefined) patch.contactUrl = body.contactUrl ? body.contactUrl.trim() : null;
  if (body.organizationId !== undefined) patch.organizationId = body.organizationId;
  if (body.assignedToUserId !== undefined) patch.assignedToUserId = body.assignedToUserId;
  const p = await repo.commerce.updateProspect(principalId, id, patch, organizationIds, actorUserId);
  if (!p) throw new ApiError(404, "not_found", "Prospect not found or team access changed.");
  return presentProspect(p, principalId);
}

export async function deleteProspect(ctx: RequestContext, id: string) {
  const { principalId } = await access(ctx, "read");
  if (!(await getRepository().commerce.deleteProspect(principalId, id))) throw new ApiError(404, "not_found", "Prospect not found.");
}

export async function exportProspectsCsv(ctx: RequestContext, status: ProspectStatus | "all", origin: string) {
  const { principalId } = await access(ctx, "read");
  const repo = getRepository();
  const organizationIds = await memberOrgIds(ctx);
  const all: Prospect[] = [];
  for (let offset = 0; offset < 10_000; offset += 200) {
    const page = await repo.commerce.listProspects({ principalId, userId: ctx.user?.id ?? null, organizationIds, status, search: null, limit: 200, offset });
    all.push(...page.items);
    if (page.items.length < 200) break;
  }
  const base = (getConfig().appUrl ?? origin).replace(/\/$/, "");
  return prospectsToCsv(all, (p) => (p.auditId ? `${base}/scans/${p.auditId}` : null));
}
