"use client";

/**
 * Scan access keys are issued once, to the browser that started a scan, and
 * kept in localStorage. They let that browser keep opening its audits even if
 * the session cookie expires or is cleared.
 *
 * To open an audit in another browser, the owner can copy a *private link*:
 * the key travels in the URL fragment (`#access=sk_…`), which browsers never
 * send to servers, logs or Referer headers. On arrival it is moved into
 * localStorage and removed from the address bar.
 */
const STORAGE_KEY = "sitelens:scan-keys";
const MAX_KEYS = 60;

type KeyMap = Record<string, { k: string; t: number }>;

function read(): KeyMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? (v as KeyMap) : {};
  } catch {
    return {};
  }
}

export function saveScanKey(scanId: string, key: string) {
  try {
    const map = read();
    map[scanId] = { k: key, t: Date.now() };
    const entries = Object.entries(map).sort((a, b) => b[1].t - a[1].t).slice(0, MAX_KEYS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* storage unavailable (private mode) — the session cookie still works */
  }
}

const KEY_RE = /^sk_[A-Za-z0-9_-]{43}$/;

/** Imports an access key from a private-link fragment for this scan (once), then strips it. */
function importFromFragment(scanId: string) {
  const m = /^#access=([^&]+)$/.exec(window.location.hash);
  if (!m || !window.location.pathname.includes(`/scans/${scanId}`)) return;
  const key = decodeURIComponent(m[1]);
  if (KEY_RE.test(key)) saveScanKey(scanId, key);
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
}

export function privateLink(scanId: string): string | null {
  const key = getScanKey(scanId);
  return key ? `${window.location.origin}/scans/${scanId}#access=${encodeURIComponent(key)}` : null;
}

export function getScanKey(scanId: string): string | null {
  if (typeof window === "undefined") return null;
  importFromFragment(scanId);
  const v = read()[scanId];
  return typeof v?.k === "string" ? v.k : null;
}
