"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, Input, Spinner } from "./ui";

/**
 * Accessible confirmation dialog (native <dialog>: focus is trapped, Esc
 * closes, focus returns to the trigger). Optionally requires typing a phrase.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  tone = "danger",
  requireText,
  busy,
  error,
  disableConfirm = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "primary";
  requireText?: string;
  busy?: boolean;
  error?: string | null;
  disableConfirm?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    if (!open) {
      const t = setTimeout(() => setTyped(""), 0);
      return () => clearTimeout(t);
    }
  }, [open]);
  const matches = !requireText || typed.trim().toLowerCase() === requireText.toLowerCase();
  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-d`}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !busy) onClose();
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/50"
    >
      <form
        method="dialog"
        className="p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (matches && !busy && !disableConfirm) onConfirm();
        }}
      >
        <h2 id={`${id}-t`} className="text-lg font-semibold">{title}</h2>
        <div id={`${id}-d`} className="mt-2 space-y-2 text-sm text-muted-foreground">{children}</div>
        {requireText ? (
          <label className="mt-4 block text-sm">
            <span className="font-medium">Type <span className="rounded bg-muted px-1 font-mono">{requireText}</span> to confirm</span>
            <Input className="mt-1.5" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus spellCheck={false} />
          </label>
        ) : null}
        {error ? <p role="alert" className="mt-3 text-sm text-danger">{error}</p> : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy} autoFocus={!requireText}>Cancel</Button>
          <Button type="submit" variant={tone === "danger" ? "danger" : "primary"} disabled={!matches || !!busy || disableConfirm}>
            {busy ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
