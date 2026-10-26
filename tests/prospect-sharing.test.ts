import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emptyCommerceStore, MemoryCommerce } from "@/lib/db/commerce-memory";

describe("explicit organization sharing for prospects", () => {
  it("keeps records private by default and exposes a shared prospect only to current organization IDs", async () => {
    const commerce = new MemoryCommerce(emptyCommerceStore());
    const owner = "user:owner";
    const orgId = randomUUID();
    const prospect = (await commerce.upsertProspect(owner, {
      hostname: "example.test", websiteUrl: "https://example.test/", auditId: null, evidence: null, auditedAt: null,
      businessName: "Example Co", notes: "Private notes",
    })).prospect;

    expect(prospect.organizationId).toBeNull();
    expect((await commerce.listProspects({ principalId: "user:member", userId: "member", organizationIds: [orgId], limit: 20, offset: 0 })).total).toBe(0);

    const shared = await commerce.updateProspect(owner, prospect.id, { organizationId: orgId }, [orgId], "owner");
    expect(shared?.organizationId).toBe(orgId);
    const visible = await commerce.listProspects({ principalId: "user:member", userId: "member", organizationIds: [orgId], limit: 20, offset: 0 });
    expect(visible.total).toBe(1);
    expect(visible.items[0].notes).toBe("Private notes");
    expect(await commerce.getProspect("user:member", prospect.id, [orgId], "member")).not.toBeNull();
    expect(await commerce.getProspect("user:outsider", prospect.id, [], "outsider")).toBeNull();
    expect((await commerce.listProspects({ principalId: "user:outsider", userId: "outsider", organizationIds: [], limit: 20, offset: 0 })).total).toBe(0);
  });

  it("preserves assignee display data on unrelated edits and clears it when made private", async () => {
    const store = emptyCommerceStore();
    const commerce = new MemoryCommerce(store);
    const orgId = randomUUID();
    const prospect = (await commerce.upsertProspect("user:owner", {
      hostname: "example.test", websiteUrl: "https://example.test/", auditId: null, evidence: null, auditedAt: null,
    })).prospect;
    Object.assign(store.prospects.get(prospect.id)!, {
      organizationId: orgId,
      assignedToUserId: randomUUID(),
      assignedToName: "Teammate",
      assignedToEmail: "teammate@example.test",
    });

    const updated = await commerce.updateProspect("user:owner", prospect.id, { notes: "Follow up" }, [orgId], "owner");
    expect(updated).toMatchObject({ assignedToName: "Teammate", assignedToEmail: "teammate@example.test" });
    const madePrivate = await commerce.updateProspect("user:owner", prospect.id, { organizationId: null }, [orgId], "owner");
    expect(madePrivate).toMatchObject({ organizationId: null, assignedToUserId: null, assignedToName: null, assignedToEmail: null });
  });

  it("lets a current member edit shared status but never transfer, unshare, or delete another owner's record", async () => {
    const commerce = new MemoryCommerce(emptyCommerceStore());
    const orgId = randomUUID();
    const prospect = (await commerce.upsertProspect("user:owner", {
      hostname: "example.test", websiteUrl: "https://example.test/", auditId: null, evidence: null, auditedAt: null,
    })).prospect;
    await commerce.updateProspect("user:owner", prospect.id, { organizationId: orgId }, [orgId], "owner");

    const updated = await commerce.updateProspect("user:member", prospect.id, { status: "reviewing" }, [orgId], "member");
    expect(updated?.status).toBe("reviewing");
    expect(await commerce.updateProspect("user:member", prospect.id, { organizationId: null }, [orgId], "member")).toBeNull();
    expect(await commerce.deleteProspect("user:member", prospect.id)).toBe(false);

    await commerce.updateProspect("user:owner", prospect.id, { organizationId: null }, [orgId], "owner");
    expect((await commerce.listProspects({ principalId: "user:member", userId: "member", organizationIds: [orgId], limit: 20, offset: 0 })).total).toBe(0);
  });
});
