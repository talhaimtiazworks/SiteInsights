"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * Interactive bits of /guide: copy-to-clipboard controls and a persistent
 * (this browser) final checklist. Both are honest about what they do:
 * copy verified via Clipboard API or selection fallback; checklist persists in
 * localStorage only, and says so.
 */

/** Real clipboard copy with a legacy fallback. Exported for tests. */
export async function copyTextToClipboard(text: string, nav?: Pick<Navigator, "clipboard">): Promise<boolean> {
  const clipboard = nav?.clipboard ?? (typeof navigator !== "undefined" ? navigator.clipboard : undefined);
  try {
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  if (typeof document === "undefined") return false;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onCopy = useCallback(() => {
    void copyTextToClipboard(text).then((ok) => {
      setState(ok ? "copied" : "failed");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 2200);
    });
  }, [text]);

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={label}
      className={`inline-flex items-center gap-1.5 rounded-lg border border-white/25 bg-white/10 px-3 py-1.5 text-[11.5px] font-semibold text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${className}`}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {state === "copied" ? <path d="M4 12.5 9.5 18 20 6.5" /> : <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></>}
      </svg>
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed — select the text" : label}</span>
    </button>
  );
}

/** A script/template card on a dark panel with a working copy control. */
export function ScriptCard({ title, scene, text, children }: { title: string; scene?: string; text: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl p-4 sm:p-5" style={{ background: "#241D3D" }}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-[13px] font-bold text-white">{title}</h4>
          {scene ? <p className="text-[11.5px]" style={{ color: "rgba(255,255,255,.6)" }}>{scene}</p> : null}
        </div>
        <CopyButton text={text} label={`Copy — ${title}`} />
      </div>
      <pre className="whitespace-pre-wrap break-words rounded-lg bg-black/25 p-3 text-[12.5px] leading-relaxed text-white/90" style={{ fontFamily: "inherit" }}>{text}</pre>
      {children}
    </div>
  );
}

const CHECKLIST_KEY = "siteinsights-guide-checklist-v1";

/** Final prospecting checklist — persisted in THIS browser's localStorage. */
export function FinalChecklist({ items }: { items: readonly { id: string; text: string }[] }) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // Deferred to a task — restoring persisted state, not a derived-render cascade.
    const timer = setTimeout(() => {
      let initial: Set<string> = new Set();
      try {
        const raw = localStorage.getItem(CHECKLIST_KEY);
        if (raw) {
          const ids = JSON.parse(raw) as unknown;
          if (Array.isArray(ids)) initial = new Set(ids.filter((x): x is string => typeof x === "string"));
        }
      } catch { /* storage unavailable — checklist still works for the session */ }
      setChecked(initial);
      setHydrated(true);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const toggle = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try {
        if (next.size) localStorage.setItem(CHECKLIST_KEY, JSON.stringify([...next]));
        else localStorage.removeItem(CHECKLIST_KEY);
      } catch { /* private mode etc. — state simply won't persist */ }
      return next;
    });
  }, []);

  const done = checked.size;
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12.5px] text-muted-foreground">
          <span className="font-semibold text-foreground">{done} of {items.length}</span> ready — saved in this browser.
        </p>
        <span aria-hidden="true" className="h-2 min-w-24 flex-1 overflow-hidden rounded-full bg-muted sm:max-w-40">
          <span className="block h-full rounded-full transition-[width] duration-300" style={{ width: `${(done / items.length) * 100}%`, background: "linear-gradient(90deg,#03D2D2,#FFC422)" }} />
        </span>
      </div>
      <ol className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {items.map((item, i) => {
          const isChecked = hydrated && checked.has(item.id);
          return (
            <li key={item.id}>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg px-1 py-1.5 transition-colors hover:bg-[rgb(var(--muted))] focus-within:ring-2 focus-within:ring-[rgb(var(--ring))]">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggle(item.id)}
                  className="mt-0.5 h-[18px] w-[18px] shrink-0"
                  aria-label={item.text}
                />
                <span className={`text-[13.5px] leading-snug ${isChecked ? "text-muted-foreground line-through decoration-2" : ""}`}>
                  <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                  {item.text}
                </span>
              </label>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
