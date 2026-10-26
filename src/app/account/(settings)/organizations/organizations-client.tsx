"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InlineError } from "@/components/load-error";
import { SettingsSkeleton } from "@/components/skeletons";
import { Alert, Badge, Button, ButtonLink, Card, CardHeader, EmptyState, Input, PageHeader, Select, Spinner } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { formatDateTime } from "@/lib/client/format";
import { useSession } from "@/lib/client/session";
import type { OrganizationSummary } from "@/lib/client/types";
import { MAX_ORGANIZATION_MEMBERS } from "@/lib/db/account-types";
import { toSignIn } from "@/lib/client/navigate";

type MemberRole = "owner" | "admin" | "member";
interface Member { userId: string; email: string | null; displayName: string | null; role: MemberRole; joinedAt: string }
interface Invitation { id: string; email: string; role: "admin" | "member"; status: "pending" | "accepted" | "rejected" | "revoked" | "expired"; createdAt: string; expiresAt: string; emailDeliveryStatus: "not_attempted" | "accepted" | "failed" | "unknown" | "not_configured"; emailLastAttemptAt: string | null; emailErrorCode: string | null }
interface RecipientInvitation { id: string; organizationId: string; organizationName: string; email: string; role: "admin" | "member"; status: "pending"; createdAt: string; expiresAt: string; invitedByName: string | null; invitedByEmail: string | null }
interface Activity { id: string; event: string; actorName: string | null; actorEmail: string | null; subjectName: string | null; subjectEmail: string | null; prospectHostname: string | null; details: Record<string, unknown>; createdAt: string }
interface TeamDetail { members: Member[]; invitations: Invitation[]; activity: Activity[] }
type Confirmation = { kind: "remove" | "leave" | "delete" | "transfer"; member?: Member };

function invitationRoleLabel(role: string) { return role === "admin" ? "Admin" : "Member"; }
function invitationDeliveryLabel(status: Invitation["emailDeliveryStatus"]) {
  switch (status) {
    case "accepted": return "Email accepted by Mailjet; inbox delivery is not confirmed.";
    case "failed": return "Email attempt failed; invitation remains pending.";
    case "unknown": return "Email delivery is unknown; check the inbox before resending.";
    case "not_configured": return "No email was sent; team email is not configured. The recipient can respond in Teams → Invitation inbox.";
    default: return "Email has not been attempted.";
  }
}

function activityMessage(item: Activity) {
  const actor = item.actorName || item.actorEmail || "A teammate";
  const subject = item.subjectName || item.subjectEmail || (typeof item.details.email === "string" ? item.details.email : "a teammate");
  switch (item.event) {
    case "organization_created": return `${actor} created the team.`;
    case "organization_renamed": return `${actor} renamed the team.`;
    case "member_added": return `${actor} added ${subject} as ${String(item.details.role ?? "a member")}.`;
    case "member_removed": return `${actor} removed ${subject}.`;
    case "member_left": return `${subject} left the team.`;
    case "member_role_changed": return `${actor} changed ${subject}'s role to ${String(item.details.toRole ?? "member")}.`;
    case "ownership_transferred": return `${actor} transferred ownership to ${subject}.`;
    case "invitation_sent": return `${actor} invited ${String(item.details.email ?? "a teammate")} as ${String(item.details.role ?? "a member")}.`;
    case "invitation_resent": return `${actor} resent the invitation to ${String(item.details.email ?? "a teammate")}.`;
    case "invitation_accepted": return `${subject} accepted a team invitation.`;
    case "invitation_rejected": return "A team invitation was declined.";
    case "invitation_revoked": return `${actor} revoked the invitation for ${String(item.details.email ?? "a teammate")}.`;
    case "prospect_shared": return `${actor} shared ${item.prospectHostname || "a prospect"} with the team.`;
    case "prospect_unshared": return `${actor} made ${item.prospectHostname || "a prospect"} private.`;
    case "prospect_assigned": return `${actor} updated the assignment for ${item.prospectHostname || "a prospect"}.`;
    case "prospect_updated": return `${actor} updated ${item.prospectHostname || "a team prospect"}.`;
    default: return `${actor} updated the team.`;
  }
}

function OrgDetail({ org, onChanged, onClose }: { org: OrganizationSummary; onChanged: () => void; onClose: () => void }) {
  const { session } = useSession();
  const me = session?.user?.id;
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [name, setName] = useState(org.name);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [formerOwnerRole, setFormerOwnerRole] = useState<"member" | "admin">("admin");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const manage = org.role !== "member";
  const owner = org.role === "owner";

  const load = useCallback(() => {
    api<TeamDetail>(`/api/organizations/${org.id}`)
      .then((d) => { setDetail({ members: d.members ?? [], invitations: d.invitations ?? [], activity: d.activity ?? [] }); setError(null); })
      .catch((e: ApiClientError) => setError(e));
  }, [org.id]);
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t); }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, successText?: string) => {
    setBusy(key);
    setMessage(null);
    try {
      await fn();
      if (successText) setMessage({ tone: "success", text: successText });
      return true;
    } catch (e) {
      setMessage({ tone: "error", text: (e as ApiClientError).message });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const revokeInvitation = async (invitation: Invitation) => {
    if (await run(`revoke:${invitation.id}`, () => api(`/api/organizations/${org.id}/invitations/${invitation.id}`, { method: "DELETE" }), `Invitation to ${invitation.email} revoked.`)) load();
  };

  const sendInvitation = async () => {
    setBusy("invite"); setMessage(null);
    try {
      const result = await api<{ invitation: Invitation; emailDelivery: { status: string; message: string } }>(`/api/organizations/${org.id}/invitations`, { method: "POST", json: { email: inviteEmail, role: inviteRole } });
      setInviteEmail("");
      setMessage({ tone: result.emailDelivery.status === "accepted" ? "success" : "warning", text: result.emailDelivery.message });
      load(); onChanged();
    } catch (e) {
      setMessage({ tone: "error", text: (e as ApiClientError).message });
    } finally { setBusy(null); }
  };

  return (
    <Card>
      <CardHeader title={name || org.name} description={`Your role: ${org.role}. Audits are read-only for teammates; prospects are shared with the team only when their owner chooses to share them.`} action={<Button variant="ghost" size="sm" onClick={onClose}>Back to teams</Button>} />
      <div className="space-y-6 p-4 sm:p-5">
        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
        {manage ? (
          <form className="flex min-w-0 flex-col gap-2 sm:flex-row" onSubmit={async (e) => {
            e.preventDefault();
            if (await run("rename", () => api(`/api/organizations/${org.id}`, { method: "PATCH", json: { name } }), "Team renamed.")) { load(); onChanged(); }
          }}>
            <label className="min-w-0 flex-1"><span className="sr-only">Team name</span><Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
            <Button type="submit" variant="outline" disabled={!name.trim() || name === org.name || busy !== null}>{busy === "rename" ? <Spinner /> : null}Rename</Button>
          </form>
        ) : null}

        <section aria-labelledby="team-members-heading">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div><h3 id="team-members-heading" className="text-sm font-semibold">Members</h3><p className="mt-0.5 text-xs text-muted-foreground">Up to {MAX_ORGANIZATION_MEMBERS} members and pending invitations combined.</p></div>
          </div>
          {error ? <InlineError error={error} what="team details" onRetry={load} /> : null}
          {!detail && !error ? <div role="status" aria-live="polite" aria-busy="true" className="mt-3"><span className="sr-only">Loading team details</span><div className="h-20 animate-pulse rounded bg-muted motion-reduce:animate-none" aria-hidden="true" /></div> : null}
          {detail ? (
            <ul className="mt-3 divide-y rounded-lg border">
              {detail.members.map((member) => (
                <li key={member.userId} className="flex min-w-0 flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:px-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{member.displayName || member.email || "Member"}{member.userId === me ? " (you)" : ""}</p>
                    <p className="break-words text-xs text-muted-foreground">{member.email || "No email on file"} · joined {formatDateTime(member.joinedAt)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {owner && member.userId !== me && member.role !== "owner" ? (
                      <label><span className="sr-only">Role for {member.displayName || member.email || "member"}</span><Select className="h-9 w-32" value={member.role} disabled={busy !== null} onChange={async (e) => {
                        const role = e.target.value as "admin" | "member";
                        if (await run(`role:${member.userId}`, () => api(`/api/organizations/${org.id}/members/${member.userId}`, { method: "PATCH", json: { role } }), `Role changed to ${role}.`)) { load(); onChanged(); }
                      }}><option value="member">Member</option><option value="admin">Admin</option></Select></label>
                    ) : <Badge className="capitalize">{member.role}</Badge>}
                    {member.userId === me ? (
                      <Button variant="ghost" size="sm" onClick={() => setConfirm({ kind: "leave", member })}>Leave</Button>
                    ) : manage && (member.role === "member" || owner) ? (
                      <Button variant="ghost" size="sm" className="text-danger" onClick={() => setConfirm({ kind: "remove", member })}>Remove</Button>
                    ) : null}
                    {owner && member.userId !== me && member.role !== "owner" ? (
                      <Button variant="outline" size="sm" onClick={() => { setFormerOwnerRole("admin"); setConfirm({ kind: "transfer", member }); }}>Make owner</Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {manage ? (
          <section className="min-w-0 rounded-lg border p-4" aria-labelledby="invite-team-heading">
            <h3 id="invite-team-heading" className="text-sm font-semibold">Invite by email</h3>
            <p className="mt-1 text-xs text-muted-foreground">Every person—including existing SiteInsights users—must explicitly accept before joining. Invitations expire after seven days. Team email is not configured, so no notification is sent and resend is unavailable; recipients can respond from Teams → Invitation inbox.</p>
            <form className="mt-3 space-y-2" onSubmit={async (e) => {
              e.preventDefault();
              await sendInvitation();
            }}>
              <label className="block"><span className="sr-only">Email address to invite</span><Input type="email" autoComplete="email" placeholder="teammate@company.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} maxLength={254} /></label>
              <div className="flex flex-col gap-2 sm:flex-row">
                {owner ? <label><span className="sr-only">Invitation role</span><Select className="w-full sm:w-32" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "admin" | "member")}><option value="member">Member</option><option value="admin">Admin</option></Select></label> : null}
                <Button type="submit" disabled={!inviteEmail.includes("@") || busy !== null}>{busy === "invite" ? <><Spinner /> Creating…</> : "Create invitation"}</Button>
              </div>
            </form>
          </section>
        ) : null}

        {manage && detail ? (
          <section aria-labelledby="pending-invitations-heading">
            <h3 id="pending-invitations-heading" className="text-sm font-semibold">Invitations</h3>
            {detail.invitations.length ? (
              <ul className="mt-2 divide-y rounded-lg border">
                {detail.invitations.map((invitation) => (
                  <li key={invitation.id} className="flex min-w-0 flex-col gap-3 px-3 py-3 sm:flex-row sm:items-start sm:px-4">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-medium">{invitation.email}</p>
                      <p className="text-xs text-muted-foreground">{invitationRoleLabel(invitation.role)} · {invitation.status === "pending" ? `expires ${formatDateTime(invitation.expiresAt)}` : invitation.status}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{invitationDeliveryLabel(invitation.emailDeliveryStatus)}{invitation.emailLastAttemptAt ? ` Last attempt: ${formatDateTime(invitation.emailLastAttemptAt)}.` : ""}</p>
                    </div>
                    {invitation.status === "pending" ? <Button size="sm" variant="ghost" className="self-start text-danger sm:self-auto" disabled={busy !== null} onClick={() => void revokeInvitation(invitation)}>{busy === `revoke:${invitation.id}` ? <><Spinner /> Revoking…</> : "Revoke"}</Button> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="mt-2 rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">No invitations yet.</p>}
          </section>
        ) : null}

        {detail ? (
          <section aria-labelledby="team-activity-heading">
            <h3 id="team-activity-heading" className="text-sm font-semibold">Recent team activity</h3>
            {detail.activity.length ? <ol className="mt-2 space-y-2 border-l-2 border-border pl-4">
              {detail.activity.slice(0, 20).map((item) => <li key={item.id} className="relative min-w-0 text-sm before:absolute before:-left-[1.32rem] before:top-2 before:h-2 before:w-2 before:rounded-full before:bg-accent"><p className="break-words">{activityMessage(item)}</p><time className="mt-0.5 block text-xs text-muted-foreground" dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time></li>)}
            </ol> : <p className="mt-2 text-sm text-muted-foreground">Team changes and shared-prospect updates will appear here.</p>}
          </section>
        ) : null}

        {owner ? <div className="border-t pt-4"><Button variant="danger" size="sm" onClick={() => setConfirm({ kind: "delete" })}>Delete team</Button></div> : null}
      </div>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === "delete" ? `Delete ${org.name}?` : confirm?.kind === "leave" ? `Leave ${org.name}?` : confirm?.kind === "transfer" ? `Make ${confirm.member?.displayName || confirm.member?.email || "this member"} the owner?` : `Remove ${confirm?.member?.displayName || confirm?.member?.email}?`}
        confirmLabel={confirm?.kind === "delete" ? "Delete team" : confirm?.kind === "leave" ? "Leave team" : confirm?.kind === "transfer" ? "Transfer ownership" : "Remove member"}
        requireText={confirm?.kind === "delete" || confirm?.kind === "transfer" ? org.name : undefined}
        busy={busy === "confirm"}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          if (!confirm) return;
          const choice = confirm;
          const ok = await run("confirm", () => {
            if (choice.kind === "delete") return api(`/api/organizations/${org.id}`, { method: "DELETE" });
            if (choice.kind === "transfer") return api(`/api/organizations/${org.id}/transfer-ownership`, { method: "POST", json: { newOwnerId: choice.member!.userId, formerOwnerRole } });
            return api(`/api/organizations/${org.id}/members/${choice.member!.userId}`, { method: "DELETE" });
          });
          setConfirm(null);
          if (ok) {
            if (choice.kind === "remove") load();
            else onClose();
            onChanged();
          }
        }}
      >
        {confirm?.kind === "delete" ? <p>The team is removed. Its audits stay with their owners and prospects return to their private lists.</p> : confirm?.kind === "leave" ? <p>You&apos;ll lose access to team-shared audits and prospects. Your own items become private. The last owner must transfer ownership or delete the team first.</p> : confirm?.kind === "transfer" ? <div className="space-y-3"><p>Ownership changes immediately. You&apos;ll keep access with the role selected below; the recipient becomes the sole team owner.</p><label className="block text-sm font-medium">Your role after transfer<Select className="mt-1" value={formerOwnerRole} onChange={(e) => setFormerOwnerRole(e.target.value as "admin" | "member")}><option value="admin">Admin</option><option value="member">Member</option></Select></label><p className="text-xs text-muted-foreground">Type the team name above to confirm this handoff.</p></div> : <p>They&apos;ll lose access to team-shared audits and prospects. Their own shared prospects become private.</p>}
      </ConfirmDialog>
    </Card>
  );
}

export function OrganizationsClient({ standalone = false }: { standalone?: boolean }) {
  const [orgs, setOrgs] = useState<OrganizationSummary[] | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [recipientInvitations, setRecipientInvitations] = useState<RecipientInvitation[]>([]);
  const [recipientLoading, setRecipientLoading] = useState(true);
  const [recipientError, setRecipientError] = useState<ApiClientError | null>(null);
  const [recipientBusy, setRecipientBusy] = useState<string | null>(null);
  const [recipientMessage, setRecipientMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [incomingError, setIncomingError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ organizations: OrganizationSummary[] }>("/api/organizations")
      .then((d) => { setOrgs(d.organizations); setError(null); })
      .catch((e: ApiClientError) => {
        if (e.status === 401) toSignIn("expired");
        else setError(e);
      });
  }, []);
  const loadRecipientInvitations = useCallback(() => {
    setRecipientLoading(true);
    api<{ invitations: RecipientInvitation[] }>("/api/organizations/invitations")
      .then((d) => { setRecipientInvitations(d.invitations ?? []); setRecipientError(null); })
      .catch((e: ApiClientError) => {
        setRecipientInvitations([]);
        if (e.status === 401) toSignIn("expired");
        else setRecipientError(e);
      })
      .finally(() => setRecipientLoading(false));
  }, []);
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t); }, [load]);
  useEffect(() => { const t = setTimeout(loadRecipientInvitations, 0); return () => clearTimeout(t); }, [loadRecipientInvitations]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const hash = new URLSearchParams(window.location.hash.slice(1));
      const token = hash.get("invite");
      if (!token) return;
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { setIncomingError("This invitation link is incomplete or invalid. Ask a team owner to create a fresh invitation."); return; }
      window.location.replace(`/teams/invitation#invite=${encodeURIComponent(token)}`);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const respondToInbox = async (invitation: RecipientInvitation, action: "accept" | "reject") => {
    if (recipientBusy) return;
    const key = `${action}:${invitation.id}`;
    setRecipientBusy(key); setRecipientMessage(null);
    try {
      await api(`/api/organizations/invitations/${invitation.id}/${action}`, { method: "POST", json: {} });
      setRecipientMessage({ tone: "success", text: action === "accept" ? `You joined ${invitation.organizationName}.` : `You declined the invitation to ${invitation.organizationName}.` });
      loadRecipientInvitations();
      if (action === "accept") load();
    } catch (e) {
      setRecipientMessage({ tone: "error", text: (e as ApiClientError).message });
      loadRecipientInvitations();
    } finally { setRecipientBusy(null); }
  };

  const open = orgs?.find((o) => o.id === openId);
  return (
    <div className={standalone ? "container max-w-5xl space-y-6 py-8 sm:py-10" : "space-y-6"}>
      <PageHeader title="Teams" description="Invite colleagues, manage access, and collaborate on the audits or prospects you choose to share." />
      <Card className="border-primary/15 bg-primary/5 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Audit sharing is private by default</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">From an owned audit&apos;s menu or report, choose a team to share its findings and recorded evidence read-only. Teammates can find them in Audits → Mine + shared with my teams. Choose Private to unshare; removing a member or deleting a team ends access without changing audit ownership.</p>
          </div>
          <ButtonLink href="/dashboard/audits?scope=all" variant="outline" size="sm" className="shrink-0">View team audits</ButtonLink>
        </div>
      </Card>
      <Card>
        <CardHeader title="Invitation inbox" description="You join a team only after accepting an invitation with the same verified email address it was sent to." />
        <div className="p-4 sm:p-5">
          {recipientMessage ? <Alert tone={recipientMessage.tone}>{recipientMessage.text}</Alert> : null}
          {recipientError ? <Alert tone={recipientError.code === "email_unverified" ? "warning" : "error"}>{recipientError.message} <button className="ml-1 font-medium underline" onClick={loadRecipientInvitations}>Try again</button></Alert> : null}
          {recipientLoading ? <p role="status" aria-live="polite" className="text-sm text-muted-foreground">Checking for invitations…</p> : null}
          {!recipientLoading && !recipientError && !recipientInvitations.length ? <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">No pending invitations for your verified email.</p> : null}
          {recipientInvitations.length ? (
            <ul className="divide-y rounded-lg border">
              {recipientInvitations.map((invitation) => (
                <li key={invitation.id} className="flex min-w-0 flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:px-4">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-semibold">{invitation.organizationName}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{invitation.invitedByName || invitation.invitedByEmail || "A team manager"} invited {invitation.email} as {invitationRoleLabel(invitation.role)}.</p>
                    <p className="mt-1 text-xs text-muted-foreground">Expires {formatDateTime(invitation.expiresAt)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={recipientBusy !== null} onClick={() => void respondToInbox(invitation, "accept")}>{recipientBusy === `accept:${invitation.id}` ? <><Spinner /> Accepting…</> : "Accept"}</Button>
                    <Button size="sm" variant="outline" disabled={recipientBusy !== null} onClick={() => void respondToInbox(invitation, "reject")}>{recipientBusy === `reject:${invitation.id}` ? <><Spinner /> Declining…</> : "Decline"}</Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Card>
      {incomingError ? <Alert tone="error">{incomingError}</Alert> : null}
      {error ? <Card><InlineError error={error} what="your teams" onRetry={load} /></Card> : null}
      {!orgs && !error ? <SettingsSkeleton label="Loading teams" embedded /> : null}
      {orgs && open ? <OrgDetail key={open.id} org={open} onChanged={load} onClose={() => setOpenId(null)} /> : null}
      {orgs && !open ? (
        <>
          <Card>
            <CardHeader title="Your teams" />
            {orgs.length === 0 ? <EmptyState title="No teams yet">Create a team, invite colleagues, then share an audit or a prospect with the team from its owner&apos;s account.</EmptyState> : (
              <ul className="divide-y">
                {orgs.map((org) => <li key={org.id} className="flex min-w-0 flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:px-5"><div className="min-w-0 flex-1"><p className="break-words font-medium">{org.name}</p><p className="text-xs text-muted-foreground">{org.memberCount} member{org.memberCount === 1 ? "" : "s"} · {org.role}</p></div><Button variant="outline" size="sm" className="self-start sm:self-auto" onClick={() => setOpenId(org.id)}>Manage</Button></li>)}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Create a team" description="You&apos;ll become its owner. You can invite teammates and transfer ownership later." />
            <form className="flex min-w-0 flex-col gap-2 p-4 sm:flex-row sm:p-5" onSubmit={async (e) => {
              e.preventDefault(); setBusy(true); setMessage(null);
              try {
                const r = await api<{ organization: { id: string } }>("/api/organizations", { method: "POST", json: { name } });
                setName(""); load(); setOpenId(r.organization.id);
              } catch (err) { setMessage((err as ApiClientError).message); }
              finally { setBusy(false); }
            }}>
              <label className="min-w-0 flex-1"><span className="sr-only">Team name</span><Input placeholder="Team name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
              <Button type="submit" disabled={!name.trim() || busy}>{busy ? <Spinner /> : null}Create team</Button>
            </form>
            {message ? <p role="alert" className="px-4 pb-4 text-sm text-danger sm:px-5">{message}</p> : null}
          </Card>
        </>
      ) : null}
    </div>
  );
}
