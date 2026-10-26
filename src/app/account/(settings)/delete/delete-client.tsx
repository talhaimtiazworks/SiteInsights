"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InlineError } from "@/components/load-error";
import { SettingsSkeleton } from "@/components/skeletons";
import { Alert, Button, Card, CardHeader, PageHeader } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { useAccount } from "@/lib/client/use-account";
import { hardNavigate } from "@/lib/client/navigate";

export function DeleteAccountClient() {
  const { data, error, loading, reload } = useAccount();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (error) return <Card><InlineError error={error} what="your account" onRetry={reload} busy={loading} /></Card>;
  if (!data) return <SettingsSkeleton label="Loading account" embedded />;
  const email = data.user.email ?? "";
  const ownedTeams = data.organizations.filter((o) => o.role === "owner");

  return (
    <div className="space-y-6">
      <PageHeader title="Delete account" />
      <Card>
        <CardHeader title="Permanently delete your account" />
        <div className="space-y-4 p-5 text-sm">
          <p>This deletes, immediately and permanently:</p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>Your {data.auditCount} audit{data.auditCount === 1 ? "" : "s"}, with their reports, issues, link checks and AI summaries</li>
            <li>Your usage history, settings and profile</li>
            <li>{ownedTeams.length ? `Teams where you are the only owner (${ownedTeams.map((o) => o.name).join(", ")}), unless another owner remains` : "Your team memberships"}</li>
            <li>Your sign-in account and every connected sign-in method</li>
          </ul>
          <p>Downloaded PDF reports are not affected. This can&apos;t be undone.</p>
          {!data.deletionAvailable ? (
            <Alert tone="warning">Self-service deletion isn&apos;t available on this deployment yet. Please contact support to delete your account.</Alert>
          ) : (
            <Button variant="danger" onClick={() => setOpen(true)}>Delete my account…</Button>
          )}
        </div>
      </Card>
      <ConfirmDialog
        open={open}
        title="Delete your account?"
        confirmLabel="Delete account permanently"
        requireText={email}
        busy={busy}
        error={err}
        onClose={() => {
          setOpen(false);
          setErr(null);
        }}
        onConfirm={async () => {
          setBusy(true);
          setErr(null);
          try {
            await api("/api/account", { method: "DELETE", json: { confirmEmail: email } });
            hardNavigate("/?account=deleted");
          } catch (e) {
            setErr((e as ApiClientError).message);
            setBusy(false);
          }
        }}
      >
        <p>All your SiteInsights data will be permanently deleted.</p>
      </ConfirmDialog>
    </div>
  );
}
