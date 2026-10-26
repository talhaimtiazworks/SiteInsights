"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Button, ButtonLink, Card, PageHeader, Spinner } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { formatDateTime } from "@/lib/client/format";
import { refreshSession, signOut, useSession } from "@/lib/client/session";
import { INVITATION_CONTINUATION_PATH } from "@/lib/auth/redirects";
import type { OrganizationInvitationStatus, OrganizationInvitationEmailStatus } from "@/lib/db/account-types";

interface Preview {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  role: "admin" | "member";
  status: OrganizationInvitationStatus;
  createdAt: string;
  expiresAt: string;
  invitedByName: string | null;
  invitedByEmail: string | null;
  emailDeliveryStatus: OrganizationInvitationEmailStatus;
}

const invitationDetailsPath = INVITATION_CONTINUATION_PATH;
const signInHref = `/sign-in?next=${encodeURIComponent(invitationDetailsPath)}`;
const signUpHref = `/sign-up?next=${encodeURIComponent(invitationDetailsPath)}`;

function roleLabel(role: Preview["role"]) { return role === "admin" ? "Admin" : "Member"; }
function statusMessage(status: OrganizationInvitationStatus) {
  switch (status) {
    case "accepted": return "This invitation has already been accepted.";
    case "rejected": return "This invitation was declined.";
    case "revoked": return "This invitation was revoked by the team.";
    case "expired": return "This invitation has expired. Ask a team owner to send a new one.";
    default: return null;
  }
}

function clearInviteFragment() {
  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

export function InvitationLandingClient() {
  const { session, loading: sessionLoading, error: sessionError } = useSession();
  const [invitation, setInvitation] = useState<Preview | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const hash = new URLSearchParams(window.location.hash.slice(1));
      const token = hash.get("invite");
      let result: { invitation: Preview | null };
      if (token !== null) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
          throw new ApiClientError(400, "invalid_invitation", "This invitation link is incomplete or invalid. Ask a team owner to create a fresh invitation.");
        }
        result = await api<{ invitation: Preview | null }>("/api/organizations/invitations/prepare", { method: "POST", json: { token } });
        clearInviteFragment();
      } else {
        result = await api<{ invitation: Preview | null }>("/api/organizations/invitations/preview");
      }
      setNow(Date.now());
      setInvitation(result.invitation);
      if (!result.invitation) setError("No invitation link is available in this browser. Ask a team owner to share the invitation link or check your Invitation inbox in Teams.");
    } catch (cause) {
      setError((cause as ApiClientError).message || "The invitation could not be loaded. Ask a team owner to create a fresh invitation or check your Invitation inbox in Teams.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  const respond = async (action: "accept" | "reject") => {
    if (busy || !invitation || invitation.status !== "pending") return;
    setBusy(action);
    setError(null);
    setMessage(null);
    try {
      await api(`/api/organizations/invitations/${action}`, { method: "POST", json: {} });
      setInvitation({ ...invitation, status: action === "accept" ? "accepted" : "rejected" });
      setMessage(action === "accept" ? "Invitation accepted. The team is now available in your account." : "Invitation declined. No team membership was created.");
    } catch (cause) {
      setError((cause as ApiClientError).message || "Your response could not be saved. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const currentStatusMessage = invitation ? statusMessage(invitation.status) : null;
  const canRespond = invitation?.status === "pending" && now !== null && Date.parse(invitation.expiresAt) > now;
  const signedIn = session?.status === "signed_in" && !!session.user;

  return (
    <main className="container max-w-2xl space-y-6 py-8 sm:py-10">
      <PageHeader title="Team invitation" description="Review who invited you and what access is being offered. Team access starts only after you explicitly accept while signed in with the invited email." />
      {loading ? <Card><div role="status" aria-live="polite" aria-busy="true" className="flex items-center gap-3 p-5"><Spinner />Loading invitation details…</div></Card> : null}
      {!loading && error && !invitation ? <Card><div className="space-y-4 p-5"><Alert tone="error">{error}</Alert><Button variant="outline" onClick={() => void load()}>Try again</Button></div></Card> : null}
      {!loading && invitation ? (
        <Card>
          <div className="space-y-4 p-5 sm:p-6">
            <div>
              <h2 className="text-lg font-semibold">Join {invitation.organizationName}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{invitation.invitedByName || invitation.invitedByEmail || "A team manager"} invited <strong className="font-medium text-foreground">{invitation.email}</strong> as a {roleLabel(invitation.role)}.</p>
            </div>
            <dl className="grid gap-3 rounded-lg border bg-muted/30 p-4 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">Invited email</dt><dd className="mt-1 break-all font-medium">{invitation.email}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Team role</dt><dd className="mt-1 font-medium">{roleLabel(invitation.role)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Invited by</dt><dd className="mt-1 break-words font-medium">{invitation.invitedByName || "Team manager"}{invitation.invitedByEmail && invitation.invitedByEmail !== invitation.invitedByName ? ` · ${invitation.invitedByEmail}` : ""}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Invitation expires</dt><dd className="mt-1 font-medium"><time dateTime={invitation.expiresAt}>{formatDateTime(invitation.expiresAt)}</time></dd></div>
            </dl>
            <p className="text-sm text-muted-foreground">You will not become a team member or gain access to team-shared audits unless you choose Accept. Declining leaves your account and private audits unchanged.</p>
            {error ? <Alert tone="error">{error}{(error.includes("verified email") || error.includes("email address the invitation was sent to")) && signedIn ? <span className="mt-2 block"><Button variant="ghost" size="sm" onClick={() => void signOut(signInHref)}>Sign out and switch account</Button></span> : null}</Alert> : null}
            {message ? <Alert tone="success">{message}</Alert> : null}
            {currentStatusMessage ? <Alert tone={invitation.status === "expired" || invitation.status === "revoked" ? "warning" : "info"}>{currentStatusMessage}</Alert> : null}
            {canRespond && signedIn ? (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void respond("accept")} disabled={busy !== null} aria-busy={busy === "accept"}>{busy === "accept" ? <><Spinner />Accepting…</> : "Accept invitation"}</Button>
                <Button variant="outline" onClick={() => void respond("reject")} disabled={busy !== null} aria-busy={busy === "reject"}>{busy === "reject" ? <><Spinner />Declining…</> : "Decline"}</Button>
              </div>
            ) : null}
            {canRespond && !signedIn ? (
              <div className="space-y-3">
                {sessionError ? <Alert tone="warning">{sessionError}<button className="ml-2 font-medium underline" onClick={() => void refreshSession(true)}>Retry session check</button></Alert> : null}
                {session?.status === "disabled" ? <Alert tone="warning">Sign-in is not configured on this deployment, so the invitation cannot be accepted here.</Alert> : null}
                {session?.status !== "disabled" && !sessionLoading ? <div className="flex flex-wrap gap-2"><ButtonLink href={signInHref}>Sign in to accept</ButtonLink><ButtonLink href={signUpHref} variant="outline">Create an account</ButtonLink></div> : null}
                {sessionLoading ? <p role="status" className="text-sm text-muted-foreground">Checking your sign-in status…</p> : null}
              </div>
            ) : null}
            {(invitation.status === "accepted" || invitation.status === "rejected") ? <ButtonLink href={signedIn ? "/teams" : "/sign-in"} variant="outline">{signedIn ? "View teams" : "Go to SiteInsights"}</ButtonLink> : null}
            {!canRespond && invitation.status === "pending" ? <Alert tone="warning">This invitation is no longer available. Ask a team owner to send a new one.</Alert> : null}
          </div>
        </Card>
      ) : null}
      <p className="text-center text-xs text-muted-foreground">SiteInsights will never ask for your password by email. The invitation link only opens this review page; it does not accept automatically.</p>
    </main>
  );
}
