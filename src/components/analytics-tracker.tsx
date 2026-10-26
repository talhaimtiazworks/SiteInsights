"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * First-party, failure-silent analytics beacon. Documents docs/ANALYTICS.md:
 *  - Visitor id: random UUID in localStorage (`sitelens.vid`, ~13 months,
 *    renewed on use). It is a first-party estimate — no cross-device identity.
 *  - Session id: random UUID in sessionStorage (`sitelens.sid`) that rotates
 *    after SESSION_IDLE_MS (30 minutes) WITHOUT activity, sliding window.
 *  - Renders nothing, sends nothing when the visitor set Do Not Track.
 *  - sendBeacon with fetch(keepalive) fallback; fire-and-forget, wrapped.
 */

const VID_KEY = "sitelens.vid";
const SID_KEY = "sitelens.sid";
const UTM_KEY = "sitelens.utm";
/** Session inactivity timeout — changing it changes the "sessions" metric. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;
const VID_TTL_MS = 395 * 24 * 3_600_000; // ~13 months

const EXCLUDE_PREFIXES = ["/api", "/admin", "/auth", "/_next", "/r/", "/sign-in", "/sign-up", "/forgot-password", "/reset-password", "/verify-email", "/favicon", "/manifest"];
const EXCLUDE_EXACT = new Set(["/robots.txt", "/sitemap.xml"]);

function uuid(): string {
  return crypto.randomUUID();
}

function dnt(): boolean {
  try {
    return navigator.doNotTrack === "1" || (window as unknown as { doNotTrack?: string }).doNotTrack === "1";
  } catch {
    return false;
  }
}

function readVisitorId(): string | null {
  try {
    const raw = localStorage.getItem(VID_KEY);
    const now = Date.now();
    if (raw) {
      const parsed = JSON.parse(raw) as { id?: string; t?: number };
      if (parsed.id && typeof parsed.t === "number" && now - parsed.t < VID_TTL_MS) {
        localStorage.setItem(VID_KEY, JSON.stringify({ id: parsed.id, t: now }));
        return parsed.id;
      }
    }
    const id = uuid();
    localStorage.setItem(VID_KEY, JSON.stringify({ id, t: now }));
    return id;
  } catch {
    return null; // storage blocked → skip tracking entirely
  }
}

function readSessionId(now: number): string {
  try {
    const raw = sessionStorage.getItem(SID_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { id?: string; last?: number };
      if (parsed.id && typeof parsed.last === "number" && now - parsed.last <= SESSION_IDLE_MS) {
        sessionStorage.setItem(SID_KEY, JSON.stringify({ id: parsed.id, last: now }));
        return parsed.id;
      }
    }
    const id = uuid();
    sessionStorage.setItem(SID_KEY, JSON.stringify({ id, last: now }));
    return id;
  } catch {
    return `mem-${uuid()}`; // sessionStorage blocked → ephemeral per-tab id
  }
}

type Utm = { source: string | null; medium: string | null; campaign: string | null };

function readUtm(): Utm {
  try {
    const existing = sessionStorage.getItem(UTM_KEY);
    if (existing) return JSON.parse(existing) as Utm;
    const p = new URLSearchParams(window.location.search);
    const utm: Utm = {
      source: p.get("utm_source")?.slice(0, 120) ?? null,
      medium: p.get("utm_medium")?.slice(0, 120) ?? null,
      campaign: p.get("utm_campaign")?.slice(0, 120) ?? null,
    };
    sessionStorage.setItem(UTM_KEY, JSON.stringify(utm));
    return utm;
  } catch {
    return { source: null, medium: null, campaign: null };
  }
}

function send(payload: Record<string, unknown>): void {
  try {
    const body = JSON.stringify(payload);
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon && navigator.sendBeacon("/api/analytics/track", blob)) return;
    void fetch("/api/analytics/track", { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" }, credentials: "same-origin" }).catch(() => {});
  } catch {
    /* tracking must never break the page */
  }
}

export function AnalyticsTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const mountedRef = useRef(false);
  const sessionAnnouncedRef = useRef<string | null>(null);
  const lastSentRef = useRef<string>("");

  useEffect(() => {
    mountedRef.current = true;
  }, []);

  useEffect(() => {
    // mount + every client-side route change
    if (!mountedRef.current) return;
    if (dnt()) return;
    const path = pathname || "/";
    if (EXCLUDE_EXACT.has(path) || EXCLUDE_PREFIXES.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`)) || /\.[a-z0-9]{2,5}$/i.test(path)) return;

    const now = Date.now();
    const visitorId = readVisitorId();
    if (!visitorId) return;
    const hadSession = (() => {
      try {
        return sessionStorage.getItem(SID_KEY);
      } catch {
        return null;
      }
    })();
    const sessionId = readSessionId(now);
    const isNewSession = !hadSession || JSON.parse(hadSession! as string).id !== sessionId;
    if (isNewSession) sessionAnnouncedRef.current = null;

    // One pageview per URL per session render pass — hydration/remount and
    // search-param churn on the same path must not double-count.
    const dedupeKey = `${sessionId}:${path}`;
    if (lastSentRef.current === dedupeKey) return;
    lastSentRef.current = dedupeKey;

    const utm = readUtm();
    if (isNewSession && sessionAnnouncedRef.current !== sessionId) {
      sessionAnnouncedRef.current = sessionId;
      send({
        eventId: uuid(),
        visitorId,
        sessionId,
        eventType: "session_start",
        path,
        referrer: document.referrer || null,
        utmSource: utm.source,
        utmMedium: utm.medium,
        utmCampaign: utm.campaign,
        language: navigator.language?.slice(0, 16) ?? null,
      });
    }
    send({
      eventId: uuid(),
      visitorId,
      sessionId,
      eventType: "pageview",
      path,
      referrer: isNewSession ? document.referrer || null : null,
      utmSource: isNewSession ? utm.source : null,
      utmMedium: isNewSession ? utm.medium : null,
      utmCampaign: isNewSession ? utm.campaign : null,
      language: null,
    });
  }, [pathname, searchParams]);

  return null;
}
