"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { Button, Card } from "@/components/ui";

interface PromptState {
  show: boolean;
  completedAudits: number;
  threshold: number;
  promptState: string;
}

const DIALOG_ID = "feedback-invite-dialog";

/**
 * Third-completed-audit feedback invitation. The source of truth is the server
 * (database), never localStorage: state survives refresh, sign-out/in and other
 * devices. A dismissal or a submitted feedback suppresses it permanently;
 * "remind me later" snoozes for 72 h server-side, so the prompt can never loop
 * on every visit. If the API is unreachable or the user is signed out it
 * renders nothing and never blocks the page.
 *
 * Mount once per surface and bump `probeKey` to re-check after an in-session
 * audit completion (the scan progress page passes its completion counter).
 */
export function FeedbackInvite({ probeKey = 0 }: { probeKey?: number }) {
  const router = useRouter();
  const [state, setState] = useState<PromptState | null>(null);
  const [responding, setResponding] = useState(false);

  const respond = useCallback(
    async (action: "remind_later" | "dismiss" | "leave") => {
      if (action === "leave") {
        router.push("/feedback");
        return;
      }
      setResponding(true);
      try {
        await api("/api/feedback/prompt", { method: "POST", json: { action } });
      } catch {
        /* storage down / signed out mid-session: hide locally; the server is authoritative next probe */
      } finally {
        setResponding(false);
        setState(null);
      }
    },
    [router],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const s = await api<PromptState>("/api/feedback/prompt", { signal: ctrl.signal });
        if (!ctrl.signal.aborted) setState(s.show ? s : null);
      } catch {
        /* 401 while signed out, storage not configured, or network noise: never interrupt the page */
      }
    })();
    return () => ctrl.abort();
  }, [probeKey]);

  // Focus management + keyboard affordances while the dialog is visible.
  useEffect(() => {
    if (!state) return;
    const root = document.getElementById(DIALOG_ID);
    root?.querySelector<HTMLButtonElement>("[data-primary]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void respond("remind_later");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // `respond` is stable (router-only dep); resubscribing per open state is intended.
  }, [state, respond]);

  if (!state) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 p-4 sm:bottom-6 sm:left-auto sm:right-6 sm:w-full sm:max-w-sm sm:p-0">
      <Card id={DIALOG_ID} role="dialog" aria-modal="true" aria-labelledby="fb-invite-title" className="pointer-events-auto p-5 shadow-xl ring-1 ring-primary/20">
        <p className="eyebrow text-primary">Quick question</p>
        <h2 id="fb-invite-title" className="mt-1.5 font-display text-[1.0625rem] font-semibold tracking-tight">
          You&apos;ve run {state.completedAudits} audits — how are we doing?
        </h2>
        <p className="mt-1.5 text-sm leading-6 text-secondary">
          Two honest sentences help more than you&apos;d think. Feature idea, rough edge, or a win worth celebrating —
          the maintainer reads every note.
        </p>
        <div className="mt-4 flex flex-col gap-2">
          <Button data-primary size="md" disabled={responding} onClick={() => void respond("leave")}>
            Leave feedback
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={responding} onClick={() => void respond("remind_later")} className="flex-1">
              Remind me later
            </Button>
            <Button variant="ghost" size="sm" disabled={responding} onClick={() => void respond("dismiss")} className="flex-1">
              No thanks
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
