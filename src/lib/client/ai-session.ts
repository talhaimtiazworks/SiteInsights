"use client";

import { useSyncExternalStore } from "react";

/**
 * Strict BYOK session state. The user's API key lives ONLY in this module's
 * memory — a page refresh, tab close, or sign-out clears it automatically.
 * It is deliberately never written to localStorage/sessionStorage/IndexedDB/
 * cookies/history; there is no persistence API here at all by design.
 *
 * Security boundary, stated honestly: while connected, the key exists in the
 * user's browser memory and is transmitted (over HTTPS, same-origin POST body)
 * to SiteInsights' authenticated endpoints which forward it to the chosen
 * provider for that single request and never store it. That's the BYOK trade:
 * we prevent persistence, leakage to other users, and reuse — the key is not
 * invisible to the page that needs it.
 */

export type AiProviderId = "openrouter" | "gemini";

interface AiSession {
  provider: AiProviderId;
  /** The user's own provider API key. Never logged or put in URLs. */
  apiKey: string;
  /** When the key last passed the genuine provider "Test connection" check. */
  validatedAt: string;
}

let session: AiSession | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function getAiSession(): AiSession | null {
  return session;
}

/** Stores the key in memory. Call this only after a genuine validation succeeded. */
export function connectAiSession(provider: AiProviderId, apiKey: string, validatedAt: string) {
  session = { provider, apiKey, validatedAt };
  emit();
}

/** Overwrites then drops the in-memory reference and notifies subscribers. */
export function disconnectAiSession() {
  if (session) {
    session = { provider: session.provider, apiKey: "", validatedAt: "" };
    session = null;
    emit();
  }
}

/** Snapshot fields any UI needs for an AI request. null when disconnected/expired-by-refresh. */
export function aiCredentials(): { provider: AiProviderId; apiKey: string } | null {
  return session ? { provider: session.provider, apiKey: session.apiKey } : null;
}

export function subscribeAiSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getServerSnapshot = () => null as AiSession | null;

/** React hook: the current BYOK session (null = not connected). */
export function useAiSession(): AiSession | null {
  return useSyncExternalStore(subscribeAiSession, getAiSession, getServerSnapshot);
}
