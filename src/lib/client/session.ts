"use client";

import { useSyncExternalStore } from "react";
import { disconnectAiSession } from "./ai-session";
import { api } from "./api";
import type { SessionInfo } from "./types";

type State = { session: SessionInfo | null; loading: boolean; error: string | null; signingOut: boolean };
const initial: State = { session: null, loading: true, error: null, signingOut: false };
const SESSION_CACHE_MS = 30_000;
let state: State = initial;
let validatedAt = 0;
const listeners = new Set<() => void>();
let inflight: Promise<SessionInfo | null> | null = null;
let revision = 0;
let lifecycleAttached = false;

function emit(next: State) {
  state = next;
  listeners.forEach((listener) => listener());
}

/** Re-read the server-validated session. Known state is reused briefly for display only. */
export function refreshSession(force = false): Promise<SessionInfo | null> {
  if (inflight && !force) return inflight;
  if (!force && state.session && !state.error && Date.now() - validatedAt < SESSION_CACHE_MS) {
    return Promise.resolve(state.session);
  }
  if (force) {
    revision++;
    inflight = null;
  }
  const version = revision;
  // Background refresh never blanks a known session or shows a blocking loading state.
  emit({ ...state, loading: !state.session, error: null });
  const request = api<SessionInfo>("/api/auth/session")
    .then((session) => {
      if (version !== revision) return null;
      validatedAt = Date.now();
      emit({ ...state, session, loading: false, error: null });
      return session;
    })
    .catch(() => {
      if (version === revision) {
        // A failed revalidation clears client-side privileges; protected pages
        // and APIs still independently authorize every request on the server.
        validatedAt = 0;
        emit({ ...state, session: null, loading: false, error: "We couldn't verify your session. Check your connection and try again." });
      }
      return null;
    })
    .finally(() => { if (inflight === request) inflight = null; });
  inflight = request;
  return request;
}

export function invalidateSession() {
  revision++;
  validatedAt = 0;
  inflight = null;
  emit({ ...state, session: null, loading: false, error: null });
}

function onVisible() {
  if (document.visibilityState === "visible" && !state.signingOut) {
    // An expired result can become valid after sign-in in another tab; do not
    // let the short display cache hide that change on the next return.
    void refreshSession(state.session?.status === "expired");
  }
}

function onSessionExpired() {
  invalidateSession();
}

function attachLifecycle() {
  if (lifecycleAttached) return;
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("siteinsights:session-expired", onSessionExpired);
  lifecycleAttached = true;
}

function detachLifecycle() {
  if (!lifecycleAttached) return;
  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("siteinsights:session-expired", onSessionExpired);
  lifecycleAttached = false;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (listeners.size === 1) attachLifecycle();
  if (!inflight && !state.error && !state.signingOut &&
      (!state.session || Date.now() - validatedAt >= SESSION_CACHE_MS)) {
    void refreshSession();
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) detachLifecycle();
  };
}

export function useSession(): State {
  return useSyncExternalStore(subscribe, () => state, () => initial);
}

/** Full navigation invalidates cached signed-in layouts. Failed logout remains recoverable. */
export async function signOut(to = "/", scope: "local" | "global" = "local"): Promise<boolean> {
  if (state.signingOut) return false;
  revision++;
  validatedAt = 0;
  inflight = null;
  // Strict BYOK: signing out always drops any in-memory provider key, even if
  // the sign-out request itself later fails (no key may survive a logout intent).
  disconnectAiSession();
  emit({ ...state, signingOut: true, loading: false, error: null });
  try {
    const result = await api<{ signedOut: boolean; sessionRevoked: boolean }>("/api/auth/sign-out", { method: "POST", json: { scope } });
    const destination = scope === "global" && !result.sessionRevoked ? `${to}${to.includes("?") ? "&" : "?"}reason=global_signout_incomplete` : to;
    emit({ ...state, session: null, error: null, signingOut: true });
    window.location.assign(destination);
    return true;
  } catch {
    emit({ ...state, signingOut: false, error: "Sign-out didn't complete. Please check your connection and try again." });
    return false;
  }
}
