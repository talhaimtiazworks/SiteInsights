/**
 * The app's API routes answer with the standard envelope `{ ok, data }` for
 * successes and `{ ok: false, error }` for failures. Every dashboard fetch
 * must unwrap `data` — reading fields off the envelope itself crashes the
 * caller with undefined-property errors (this was the production dashboard
 * crash of 2026-10-23).
 */
export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export function unwrapApi<T>(json: unknown, status: number): T {
  const env = json as ApiEnvelope<T> | null;
  if (env && typeof env === "object" && "ok" in env) {
    if (env.ok === false) {
      const code = env.error?.code ?? `http_${status}`;
      throw new Error(`Request failed: ${code}`);
    }
    if ("data" in env) return env.data as T;
  }
  // Non-enveloped payloads (should not happen for these routes) pass through.
  return json as T;
}
