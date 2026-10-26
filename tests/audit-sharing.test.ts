import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMembership, memberOrganizationIds, getRepository, getAuditContext, ensureProfile } = vi.hoisted(() => ({
  getMembership: vi.fn(),
  memberOrganizationIds: vi.fn(),
  getRepository: vi.fn(),
  getAuditContext: vi.fn(),
  ensureProfile: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  getRepository,
  getAccountRepository: () => ({ getMembership, ensureProfile, memberOrganizationIds }),
  maybeAccountRepository: () => ({ getMembership, ensureProfile, memberOrganizationIds }),
  storageInfo: () => ({ mode: "memory", persistent: false, ready: true, serverless: false }),
}));
vi.mock("@/lib/http/context", () => ({ getAuditContext, throttle: vi.fn() }));

import { MemoryRepository } from "@/lib/db/memory";
import { loadConfig } from "@/lib/config/env";
import { loadScanAccess } from "@/lib/services/scans";
import { createScanJob } from "@/lib/scanner/engine";
import * as scanRoute from "@/app/api/scans/[id]/route";
import * as findingsRoute from "@/app/api/scans/[id]/findings/route";
import * as auditsRoute from "@/app/api/audits/route";

const OWNER = "11111111-2222-4333-8444-555555555555";
const MEMBER = "22222222-3333-4444-8555-666666666666";
const OUTSIDER = "33333333-4444-4555-8666-777777777777";
const ORGANIZATION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_ORGANIZATION = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const context = (userId: string) => ({ principalId: `user:${userId}`, user: { id: userId }, auth: "signed_in" as const });

beforeEach(() => {
  vi.clearAllMocks();
  getMembership.mockImplementation(async (organizationId: string, userId: string) =>
    organizationId === ORGANIZATION && (userId === OWNER || userId === MEMBER) ? (userId === OWNER ? "owner" : "member") : null,
  );
  memberOrganizationIds.mockImplementation(async (userId: string) => (await getMembership(ORGANIZATION, userId)) ? [ORGANIZATION] : []);
  ensureProfile.mockResolvedValue(undefined);
  getAuditContext.mockImplementation(async () => context(OWNER));
});

describe("audit team-sharing persistence and authorization", () => {
  it("keeps audits private by default, exposes a shared audit read-only to current members, and makes it private again", async () => {
    const repo = new MemoryRepository();
    const job = createScanJob({ principalId: `user:${OWNER}`, websiteId: null, targetUrl: "https://audit.example.test/", limits: loadConfig({}).scanner });
    await repo.createScan(job);
    expect((await repo.getScan(job.id))?.organizationId ?? null).toBeNull();
    await expect(loadScanAccess(repo, job.id, context(MEMBER), "read")).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(loadScanAccess(repo, job.id, context(OUTSIDER), "read")).rejects.toMatchObject({ status: 404, code: "not_found" });

    expect(await repo.updateScanMeta(job.id, { organizationId: ORGANIZATION }, {
      principalId: `user:${OWNER}`,
      organizationMemberUserId: OWNER,
      expectedOrganizationId: null,
    })).toBe(true);
    expect((await repo.getScan(job.id))?.organizationId).toBe(ORGANIZATION);

    const shared = await loadScanAccess(repo, job.id, context(MEMBER), "read");
    expect(shared.viewer).toEqual({ canEdit: false, viaOrganization: true });
    await expect(loadScanAccess(repo, job.id, context(OUTSIDER), "read")).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(loadScanAccess(repo, job.id, context(MEMBER), "write")).rejects.toMatchObject({ status: 404, code: "not_found" });

    getMembership.mockResolvedValue(null); // same organization, but the member has been removed
    await expect(loadScanAccess(repo, job.id, context(MEMBER), "read")).rejects.toMatchObject({ status: 404, code: "not_found" });

    getMembership.mockImplementation(async (organizationId: string, userId: string) =>
      organizationId === ORGANIZATION && userId === OWNER ? "owner" : null,
    );
    expect(await repo.updateScanMeta(job.id, { organizationId: null }, {
      principalId: `user:${OWNER}`,
      expectedOrganizationId: ORGANIZATION,
    })).toBe(true);
    expect((await repo.getScan(job.id))?.organizationId ?? null).toBeNull();
    await expect(loadScanAccess(repo, job.id, context(MEMBER), "read")).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("rejects stale share changes and edits attempted by someone other than the stored owner", async () => {
    const repo = new MemoryRepository();
    const job = createScanJob({ principalId: `user:${OWNER}`, websiteId: null, targetUrl: "https://audit.example.test/", limits: loadConfig({}).scanner });
    await repo.createScan(job);
    const access = { principalId: `user:${OWNER}`, organizationMemberUserId: OWNER, expectedOrganizationId: null };
    expect(await repo.updateScanMeta(job.id, { organizationId: ORGANIZATION }, access)).toBe(true);
    expect(await repo.updateScanMeta(job.id, { organizationId: null }, access)).toBe(false);
    expect(await repo.updateScanMeta(job.id, { organizationId: null }, { principalId: `user:${OUTSIDER}`, expectedOrganizationId: ORGANIZATION })).toBe(false);
    expect((await repo.getScan(job.id))?.organizationId).toBe(ORGANIZATION);

    const listed = await repo.listAudits({ principalId: `user:${MEMBER}`, organizationIds: [ORGANIZATION], page: 1, pageSize: 10 });
    expect(listed.items.map((item) => item.id)).toEqual([job.id]);
    const unrelated = await repo.listAudits({ principalId: `user:${OUTSIDER}`, organizationIds: [], page: 1, pageSize: 10 });
    expect(unrelated.items).toHaveLength(0);
  });

  it("lets only one competing share change with the same expected organization win", async () => {
    const repo = new MemoryRepository();
    const job = createScanJob({ principalId: `user:${OWNER}`, websiteId: null, targetUrl: "https://audit.example.test/", limits: loadConfig({}).scanner });
    await repo.createScan(job);
    const access = { principalId: `user:${OWNER}`, organizationMemberUserId: OWNER, expectedOrganizationId: null };
    const results = await Promise.all([
      repo.updateScanMeta(job.id, { organizationId: ORGANIZATION }, access),
      repo.updateScanMeta(job.id, { organizationId: OTHER_ORGANIZATION }, access),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect([ORGANIZATION, OTHER_ORGANIZATION]).toContain((await repo.getScan(job.id))?.organizationId);
  });

  it("enforces explicit membership, read-only member access, and compare-and-set at the API", async () => {
    const repo = new MemoryRepository();
    const job = createScanJob({ principalId: `user:${OWNER}`, websiteId: null, targetUrl: "https://audit.example.test/", limits: loadConfig({}).scanner });
    job.status = "completed";
    job.phase = "finished";
    job.finishedAt = new Date().toISOString();
    await repo.createScan(job);
    getRepository.mockReturnValue(repo);
    let actor = OWNER;
    getAuditContext.mockImplementation(async () => context(actor));
    const params = { params: Promise.resolve({ id: job.id }) } as never;
    const request = (method: string, path: string, body?: unknown) => new NextRequest(`https://siteinsight.local${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });

    const missingCas = await scanRoute.PATCH(request("PATCH", `/api/scans/${job.id}`, { organizationId: ORGANIZATION }), params);
    expect(missingCas.status).toBe(400);
    const refused = await scanRoute.PATCH(request("PATCH", `/api/scans/${job.id}`, { organizationId: OTHER_ORGANIZATION, expectedOrganizationId: null }), params);
    expect(refused.status).toBe(404);
    expect((await repo.getScan(job.id))?.organizationId ?? null).toBeNull();

    const share = await scanRoute.PATCH(request("PATCH", `/api/scans/${job.id}`, { organizationId: ORGANIZATION, expectedOrganizationId: null }), params);
    expect(share.status).toBe(200);
    expect((await share.json() as { data: { organizationId: string } }).data.organizationId).toBe(ORGANIZATION);

    actor = MEMBER;
    const memberFindings = await findingsRoute.GET(request("GET", `/api/scans/${job.id}/findings`), params);
    expect(memberFindings.status).toBe(200); // shared read endpoint is not owner-only
    const memberAudits = await auditsRoute.GET(request("GET", "/api/audits?scope=all"), {} as never);
    expect(memberAudits.status).toBe(200);
    expect((await memberAudits.json() as { data: { items: Array<{ id: string; mine: boolean; organizationId: string | null }> } }).data.items).toContainEqual(expect.objectContaining({ id: job.id, mine: false, organizationId: ORGANIZATION }));
    const memberRename = await scanRoute.PATCH(request("PATCH", `/api/scans/${job.id}`, { title: "not allowed" }), params);
    expect(memberRename.status).toBe(404);

    actor = OUTSIDER;
    const outsiderFindings = await findingsRoute.GET(request("GET", `/api/scans/${job.id}/findings`), params);
    expect(outsiderFindings.status).toBe(404);
    const outsiderAudits = await auditsRoute.GET(request("GET", "/api/audits?scope=all"), {} as never);
    expect(outsiderAudits.status).toBe(200);
    expect((await outsiderAudits.json() as { data: { items: Array<{ id: string }> } }).data.items).toHaveLength(0);

    actor = OWNER;
    const stale = await scanRoute.PATCH(request("PATCH", `/api/scans/${job.id}`, { organizationId: null, expectedOrganizationId: null }), params);
    expect(stale.status).toBe(409);
    expect((await stale.json() as { error: { code: string } }).error.code).toBe("audit_sharing_conflict");
    const unshare = await scanRoute.PATCH(request("PATCH", `/api/scans/${job.id}`, { organizationId: null, expectedOrganizationId: ORGANIZATION }), params);
    expect(unshare.status).toBe(200);
    expect((await repo.getScan(job.id))?.organizationId ?? null).toBeNull();
    actor = MEMBER;
    expect((await findingsRoute.GET(request("GET", `/api/scans/${job.id}/findings`), params)).status).toBe(404);
    const afterUnshare = await auditsRoute.GET(request("GET", "/api/audits?scope=all"), {} as never);
    expect((await afterUnshare.json() as { data: { items: Array<{ id: string }> } }).data.items).toHaveLength(0);
  });
});
