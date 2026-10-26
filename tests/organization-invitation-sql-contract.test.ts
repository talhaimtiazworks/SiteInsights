import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "src/lib/db/postgres.ts"), "utf8");
const method = (name: string, next: string) => {
  const start = source.indexOf(name);
  const end = source.indexOf(next, start + name.length);
  expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
  expect(end, `${next} follows ${name}`).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe("Postgres team invitation transaction contract", () => {
  it("locks the organization and invitation inside one transaction before a membership grant", () => {
    const respond = method("private async respondToInvitation(", "async acceptInvitation(");
    expect(respond).toContain("sql.begin(async (tx) =>");
    const orgLock = respond.indexOf("FROM organizations WHERE id = ${hint.organization_id} FOR UPDATE");
    const inviteLock = respond.indexOf("FROM organization_invitations WHERE token_hash = ${selector.value} FOR UPDATE");
    const membershipGrant = respond.indexOf("INSERT INTO organization_members");
    expect(orgLock).toBeGreaterThanOrEqual(0);
    expect(inviteLock).toBeGreaterThan(orgLock);
    expect(membershipGrant).toBeGreaterThan(inviteLock);
  });

  it("counts a reactivated expired invitation against the member limit", () => {
    const create = method("async createInvitation(", "async resendInvitation(");
    expect(create).toContain("expires_at > now() AS active");
    expect(create).toContain("if (!existing?.active)");
    expect(create).toContain("status = 'pending' AND expires_at > now()");
    expect(create).toContain("counts.members + counts.invitations >= MAX_ORGANIZATION_MEMBERS");
  });

  it("checks exact server-normalized email, pending state, expiry and capacity before accepting", () => {
    const respond = method("private async respondToInvitation(", "async acceptInvitation(");
    expect(respond).toContain("if (invite.invited_email !== email) return \"email_mismatch\"");
    expect(respond).toContain("if (invite.status === \"expired\") return \"expired\"");
    expect(respond).toContain("if (invite.status !== \"pending\") return \"not_pending\"");
    expect(respond).toContain("expires_at <= now() RETURNING id");
    expect(respond).toContain("count(*)::int AS n FROM organization_members");
    expect(respond).toContain("if (count.n >= MAX_ORGANIZATION_MEMBERS) return \"member_limit\"");
    expect(respond).toContain("accepted_by_user_id = ${userId}");
    expect(respond).toContain("status = 'accepted'");
  });

  it("keeps reject separate from member insertion and audits the response", () => {
    const respond = method("private async respondToInvitation(", "async acceptInvitation(");
    const rejectStart = respond.indexOf("await tx`UPDATE organization_invitations SET status = 'rejected'");
    expect(rejectStart).toBeGreaterThanOrEqual(0);
    const rejectTail = respond.slice(rejectStart);
    expect(rejectTail).toContain("event: \"invitation_rejected\"");
    expect(rejectTail).not.toContain("INSERT INTO organization_members");
  });

  it("persists the no-email status in the same transaction as invitation creation or rotation", () => {
    const create = method("async createInvitation(", "async resendInvitation(");
    expect(create).toContain("email_delivery_status, email_error_code)");
    expect(create).toContain("${input.emailDeliveryStatus}, ${input.emailErrorCode}");
    expect(create).toContain("email_delivery_status = EXCLUDED.email_delivery_status");
    expect(create).toContain("email_error_code = EXCLUDED.email_error_code");
  });

  it("does not label a configuration-disabled invitation as an attempted email", () => {
    const deliveryStatus = method("async updateInvitationEmailStatus(", "async listInvitations(");
    expect(deliveryStatus).toContain("CASE WHEN ${input.status} = 'not_configured' THEN NULL ELSE now() END");
  });

  it("does not copy invitee email addresses into team-wide activity details", () => {
    const create = method("async createInvitation(", "async resendInvitation(");
    const respond = method("private async respondToInvitation(", "async acceptInvitation(");
    expect(create).toContain("event: \"invitation_sent\", details: { role: row.role }");
    expect(create).not.toContain("details: { email: row.invited_email");
    expect(respond).not.toContain("details: { email: invite.invited_email");
    expect(respond).toContain("actorUserId: null, event: \"invitation_rejected\"");
    expect(source).toContain("if (r.event_type.startsWith(\"invitation_\")) delete details.email");
    expect(source).toContain("actorName: privateDecline ? null : r.actor_name");
  });

  it("filters recipient inbox rows by normalized verified email and unexpired pending status", () => {
    const inbox = method("async listRecipientInvitations(", "async getInvitationPreview(");
    expect(inbox).toContain("lower(i.invited_email) = ${email}");
    expect(inbox).toContain("i.status = 'pending'");
    expect(inbox).toContain("i.expires_at > now()");
    expect(inbox).toContain("LIMIT 50");
  });

  it("leaves audit visibility to current organization membership and per-audit share state", () => {
    const auditAccess = readFileSync(path.join(process.cwd(), "src/lib/services/scans.ts"), "utf8");
    expect(auditAccess).toContain("accounts.getMembership(scan.organizationId, ctx.user.id)");
    expect(auditAccess).toContain("scan.organizationId");
    expect(auditAccess).toContain("viaOrganization: true");
    const route = readFileSync(path.join(process.cwd(), "src/app/api/scans/[id]/route.ts"), "utf8");
    expect(route).toContain("loadScanAccess");
    expect(route).toContain("expectedOrganizationId");
  });
});
