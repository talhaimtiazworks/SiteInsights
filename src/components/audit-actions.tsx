"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { api, ApiClientError } from "@/lib/client/api";
import { refreshSession } from "@/lib/client/session";
import { saveScanKey } from "@/lib/client/scan-keys";
import { ConfirmDialog } from "./confirm-dialog";
import { Input } from "./ui";

export interface ActionTarget {
  id: string;
  title: string | null;
  targetUrl: string;
}

/**
 * Rename / rerun / delete for one audit, with confirmation dialogs. All
 * ownership checks happen on the server; errors are shown as returned.
 */
export function useAuditActions({ onChanged, onDeleted }: { onChanged?: () => void; onDeleted?: (id: string) => void } = {}) {
  const router = useRouter();
  const rerunLock = useRef(false);
  const [renaming, setRenaming] = useState<ActionTarget | null>(null);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<ActionTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState<string | null>(null);

  const close = () => {
    setRenaming(null);
    setDeleting(null);
    setDialogError(null);
  };

  const rerun = useCallback(
    async (t: ActionTarget) => {
      if (rerunLock.current) return;
      rerunLock.current = true;
      setRerunning(t.id);
      setError(null);
      try {
        const session = await refreshSession(true);
        if (!session?.user || session.status !== "signed_in") throw new ApiClientError(401, "auth_required", "Sign in again before re-running an audit.");
        const scan = await api<{ id: string; accessKey: string | null }>(`/api/scans/${t.id}/rerun`, { method: "POST", json: {}, headers: { "Idempotency-Key": `rerun-${crypto.randomUUID()}` } });
        if (scan.accessKey) saveScanKey(scan.id, scan.accessKey);
        window.dispatchEvent(new Event("siteinsights:navigate"));
        router.push(`/scans/${scan.id}/progress`);
      } catch (e) {
        setError((e as ApiClientError).message);
        setRerunning(null);
      } finally {
        rerunLock.current = false;
      }
    },
    [router],
  );

  const dialogs: ReactNode = (
    <>
      <ConfirmDialog
        open={!!renaming}
        title="Rename audit"
        confirmLabel="Save name"
        tone="primary"
        busy={busy}
        error={dialogError}
        onClose={close}
        onConfirm={async () => {
          if (!renaming) return;
          setBusy(true);
          setDialogError(null);
          try {
            await api(`/api/scans/${renaming.id}`, { method: "PATCH", json: { title: name.trim() || null } });
            close();
            onChanged?.();
          } catch (e) {
            setDialogError((e as ApiClientError).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block">
          <span className="text-sm font-medium text-foreground">Name</span>
          <Input className="mt-1.5" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder={renaming?.targetUrl} autoFocus />
        </label>
        <p>Leave empty to show the website address instead.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!deleting}
        title="Delete this audit?"
        confirmLabel="Delete audit"
        busy={busy}
        error={dialogError}
        onClose={close}
        onConfirm={async () => {
          if (!deleting) return;
          setBusy(true);
          setDialogError(null);
          try {
            await api(`/api/scans/${deleting.id}`, { method: "DELETE" });
            const id = deleting.id;
            close();
            onDeleted?.(id);
            onChanged?.();
          } catch (e) {
            setDialogError((e as ApiClientError).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          <strong className="text-foreground">{deleting?.title || deleting?.targetUrl}</strong> and its report, issues, link checks and AI summaries will be permanently deleted. A running audit is stopped first. This can&apos;t be undone.
        </p>
      </ConfirmDialog>
    </>
  );

  return {
    dialogs,
    error,
    clearError: () => setError(null),
    rerunning,
    rename: (t: ActionTarget) => {
      setName(t.title ?? "");
      setDialogError(null);
      setRenaming(t);
    },
    remove: (t: ActionTarget) => {
      setDialogError(null);
      setDeleting(t);
    },
    rerun,
  };
}
