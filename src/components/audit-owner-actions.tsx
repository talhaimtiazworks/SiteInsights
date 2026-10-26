"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiClientError } from "@/lib/client/api";
import { useSession } from "@/lib/client/session";
import type { OrganizationSummary, PublicScan } from "@/lib/client/types";
import { useAuditActions } from "./audit-actions";
import { ConfirmDialog } from "./confirm-dialog";
import { Alert, Badge, Button, ButtonLink, Select, Spinner } from "./ui";

interface AuditShareButtonProps {
  scanId: string;
  organizationId: string | null;
  onChanged?: () => void;
  triggerLabel?: string;
  triggerClassName?: string;
  triggerVariant?: "primary" | "secondary" | "ghost" | "danger" | "outline";
  triggerSize?: "sm" | "md" | "lg";
  triggerRole?: string;
  onOpened?: () => void;
}

/** Explicit, owner-only sharing control reused on audit rows and report pages. */
export function AuditShareButton({
  scanId,
  organizationId,
  onChanged,
  triggerLabel = organizationId ? "Manage sharing" : "Share with a team",
  triggerClassName,
  triggerVariant = "outline",
  triggerSize = "sm",
  triggerRole,
  onOpened,
}: AuditShareButtonProps) {
  const [shareOpen, setShareOpen] = useState(false);
  const [orgs, setOrgs] = useState<OrganizationSummary[] | null>(null);
  const [orgId, setOrgId] = useState(organizationId ?? "");
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  useEffect(() => {
    if (!shareOpen) return;
    let current = true;
    api<{ organizations: OrganizationSummary[] }>("/api/organizations")
      .then((d) => { if (current) setOrgs(d.organizations); })
      .catch((e: ApiClientError) => { if (current) setShareError(e.message); });
    return () => { current = false; };
  }, [shareOpen]);

  const canSave = !shareBusy && (
    orgId === organizationId ||
    (orgId === "" && !!organizationId) ||
    (!!orgId && !shareError && !!orgs?.some((org) => org.id === orgId))
  );

  return (
    <>
      <Button
        type="button"
        role={triggerRole}
        variant={triggerVariant}
        size={triggerSize}
        className={triggerClassName}
        onClick={() => {
          setOrgs(null);
          setOrgId(organizationId ?? "");
          setShareError(null);
          setShareOpen(true);
          onOpened?.();
        }}
      >
        {triggerLabel}
      </Button>
      <ConfirmDialog
        open={shareOpen}
        title={organizationId ? "Manage team sharing" : "Share this audit"}
        confirmLabel={orgId ? "Save team access" : organizationId ? "Make private" : "Save"}
        tone="primary"
        busy={shareBusy}
        error={shareError}
        disableConfirm={!canSave}
        onClose={() => { setShareOpen(false); setShareError(null); }}
        onConfirm={async () => {
          if (!canSave) return;
          setShareBusy(true);
          setShareError(null);
          try {
            await api(`/api/scans/${scanId}`, {
              method: "PATCH",
              json: { organizationId: orgId || null, expectedOrganizationId: organizationId },
            });
            setShareOpen(false);
            onChanged?.();
          } catch (e) {
            setShareError((e as ApiClientError).message);
          } finally {
            setShareBusy(false);
          }
        }}
      >
        <p>Audits are private until you choose a team. Current team members can read the report, findings, pages, links, and recorded evidence; only you can rename, rerun, triage, or delete the audit.</p>
        <p>Client report links keep their existing expiry and revocation rules. PDF exports still follow each viewer&apos;s plan and credit allowance.</p>
        {orgs === null && !shareError ? (
          <p role="status" aria-live="polite">Loading your teams…</p>
        ) : orgs && orgs.length === 0 ? (
          <p>You aren&apos;t in any teams yet. <a className="font-medium text-primary underline underline-offset-4" href="/teams">Create a team</a> first.</p>
        ) : null}
        <label className="block">
          <span className="text-sm font-medium text-foreground">Team access</span>
          <Select
            className="mt-1.5 w-full"
            value={orgId}
            disabled={shareBusy || (orgs === null && !organizationId) || (!!shareError && !organizationId)}
            onChange={(e) => setOrgId(e.target.value)}
          >
            <option value="">Private — only you</option>
            {organizationId && !orgs?.some((org) => org.id === organizationId) ? <option value={organizationId}>Current team (unavailable)</option> : null}
            {orgs?.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
          </Select>
          <span className="mt-1.5 block text-xs">Removing a teammate or deleting the team ends that teammate&apos;s access. This does not transfer audit ownership.</span>
        </label>
      </ConfirmDialog>
    </>
  );
}

/**
 * Owner actions for one audit (report and progress pages). Only rendered for
 * viewers the server marked as able to edit; team members viewing a shared
 * audit see a badge instead. Every action is re-checked on the server.
 */
export function AuditOwnerActions({ scan, onChanged }: { scan: Pick<PublicScan, "id" | "title" | "targetUrl" | "status" | "hasResults" | "viewer" | "organizationId" | "ownedByAccount">; onChanged?: () => void }) {
  const router = useRouter();
  const { session } = useSession();
  const actions = useAuditActions({ onChanged, onDeleted: () => router.push("/dashboard/audits") });
  const canShare = !!session?.user && scan.ownedByAccount;

  if (scan.viewer?.viaOrganization) return <Badge className="text-muted-foreground">Shared with your team · view only</Badge>;
  if (scan.viewer && !scan.viewer.canEdit) return null;
  const terminal = scan.status === "completed" || scan.status === "failed" || scan.status === "cancelled";

  return (
    <>
      {actions.dialogs}
      <Badge className={scan.organizationId ? "border-primary/20 bg-primary/5 text-primary" : "border-border text-muted-foreground"}>{scan.organizationId ? "Shared with team" : "Private"}</Badge>
      {scan.hasResults ? <ButtonLink href={`/dashboard/compare?a=${scan.id}`} variant="outline" size="sm">Compare</ButtonLink> : null}
      <Button variant="outline" size="sm" onClick={() => actions.rename(scan)}>Rename</Button>
      {terminal ? (
        <Button variant="outline" size="sm" onClick={() => actions.rerun(scan)} disabled={actions.rerunning === scan.id}>
          {actions.rerunning === scan.id ? <Spinner /> : null}
          {scan.status === "completed" ? "Run again" : "Retry audit"}
        </Button>
      ) : null}
      {canShare ? <AuditShareButton scanId={scan.id} organizationId={scan.organizationId} onChanged={onChanged} /> : null}
      <Button variant="ghost" size="sm" className="text-danger" onClick={() => actions.remove(scan)}>Delete</Button>
      {actions.error ? <Alert tone="error" className="basis-full">{actions.error}</Alert> : null}
    </>
  );
}
