import { renderResultSchema, type RenderRequestInput, type RenderResult, workerHealthSchema, type WorkerHealth } from "./protocol";

/**
 * Client for the external SiteInsights browser worker. Website code never runs in
 * the app process: the app only sends a URL and receives a bounded JSON result.
 *
 * Worker problems (unreachable, busy, bad token, malformed reply) are returned
 * as `{ ok: false }` so the engine can skip rendering without blaming the site.
 * Page problems (timeout, crash, blocked destination) arrive inside a valid
 * RenderResult with `ok: false` and become findings.
 */
export type WorkerFailureCode = "worker_unavailable" | "worker_busy" | "worker_auth" | "worker_timeout" | "invalid_response";
export type RenderOutcome = { ok: true; result: RenderResult } | { ok: false; code: WorkerFailureCode; message: string };

export interface BrowserClientOptions {
  workerUrl: string;
  token: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

function endpoint(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

export async function renderPage(req: RenderRequestInput, opts: BrowserClientOptions): Promise<RenderOutcome> {
  const f = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  let res: Response;
  try {
    res = await f(endpoint(opts.workerUrl, "v1/render"), {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(req),
      signal: ctrl.signal,
      cache: "no-store",
      redirect: "error",
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error)?.name === "AbortError") return { ok: false, code: "worker_timeout", message: `The browser worker did not answer within ${Math.round(opts.timeoutMs / 1000)} s.` };
    return { ok: false, code: "worker_unavailable", message: "The browser worker could not be reached." };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* handled below */
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) return { ok: false, code: "worker_auth", message: "The browser worker rejected the access token." };
  if (res.status === 429 || res.status === 503) return { ok: false, code: "worker_busy", message: "The browser worker is busy." };
  if (!res.ok && res.status !== 422) return { ok: false, code: "worker_unavailable", message: `The browser worker returned HTTP ${res.status}.` };
  const parsed = renderResultSchema.safeParse(body);
  if (!parsed.success) return { ok: false, code: "invalid_response", message: "The browser worker returned an unexpected response." };
  return { ok: true, result: parsed.data };
}

export async function checkWorkerHealth(opts: BrowserClientOptions): Promise<{ ok: true; health: WorkerHealth } | { ok: false; message: string }> {
  const f = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(opts.timeoutMs, 5000));
  try {
    const res = await f(endpoint(opts.workerUrl, "healthz"), { headers: { Authorization: `Bearer ${opts.token}` }, signal: ctrl.signal, cache: "no-store", redirect: "error" });
    const parsed = workerHealthSchema.safeParse(await res.json().catch(() => null));
    if (!res.ok || !parsed.success) return { ok: false, message: res.status === 401 ? "Token rejected" : `HTTP ${res.status}` };
    return { ok: true, health: parsed.data };
  } catch {
    return { ok: false, message: "Unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
