"use client";


export class ApiClientError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

/** Fetches a SiteInsights API route and unwraps the { ok, data } envelope. */
export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      signal: rest.signal ?? AbortSignal.timeout(path.endsWith("/advance") ? 95_000 : 45_000),
      headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...rest.headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiClientError(0, "network_error", "Could not reach the server. Check your connection and try again.");
  }
  let body: { ok?: boolean; data?: T; error?: { code: string; message: string; details?: Record<string, unknown> } } | null = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok || !body?.ok) {
    if (!body?.error?.code) {
      // Not one of our JSON envelopes (platform error page, timeout, malformed
      // body). Never interpreted as "not found" — callers key off error codes.
      throw new ApiClientError(res.status || 0, "unexpected_response", "The server returned an unexpected response. Please try again.");
    }
    if (res.status === 401 && ["auth_required", "session_expired"].includes(body.error.code) && typeof window !== "undefined") window.dispatchEvent(new Event("siteinsights:session-expired"));
    throw new ApiClientError(res.status, body?.error?.code ?? "http_error", body?.error?.message ?? `Request failed (HTTP ${res.status}).`, body?.error?.details);
  }
  return body.data as T;
}
