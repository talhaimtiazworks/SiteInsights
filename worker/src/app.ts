import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { RENDER_PROTOCOL_VERSION, renderRequestSchema, type RenderRequest, type RenderResult } from "../../src/lib/browser/protocol";

/**
 * HTTP front end of the browser worker (no Playwright import, so it can be
 * tested with a fake renderer).
 *
 *   GET  /livez       unauthenticated liveness ("ok"), for platform health checks
 *   GET  /healthz     authenticated status (capacity, browser version)
 *   POST /v1/render   authenticated; body = RenderRequest; reply = RenderResult
 *
 * Auth: "Authorization: Bearer <WORKER_TOKEN>", compared in constant time.
 * At most `capacity` renders run at once; extra requests get 429 immediately.
 */

export type Renderer = (req: RenderRequest) => Promise<RenderResult>;

export interface WorkerServerOptions {
  token: string;
  renderer: Renderer;
  capacity: number;
  browserVersion?: () => string | null;
  maxBodyBytes?: number;
  log?: (msg: string) => void;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const a = createHash("sha256").update(m[1].trim()).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
  res.end(json);
}

export function createWorkerServer(opts: WorkerServerOptions): http.Server & { busy(): number } {
  if (!opts.token || opts.token.length < 24) throw new Error("WORKER_TOKEN must be at least 24 characters.");
  const maxBody = opts.maxBodyBytes ?? 64 * 1024;
  let busy = 0;
  const log = opts.log ?? (() => {});

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://worker");
    if (req.method === "GET" && url.pathname === "/livez") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (!tokenMatches(req.headers.authorization, opts.token)) {
      send(res, 401, { error: { code: "unauthorized", message: "Missing or invalid token." } }, { "www-authenticate": "Bearer" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      send(res, 200, { ok: true, version: RENDER_PROTOCOL_VERSION, busy, capacity: opts.capacity, browser: opts.browserVersion?.() ?? null });
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/v1/render") {
      send(res, 404, { error: { code: "not_found", message: "Not found." } });
      return;
    }
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      send(res, 415, { error: { code: "invalid_request", message: "Content-Type must be application/json." } });
      return;
    }
    // Read the (small) body with a hard cap.
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBody) {
        tooBig = true;
        break;
      }
      chunks.push(chunk as Buffer);
    }
    if (tooBig) {
      send(res, 413, { error: { code: "invalid_request", message: "Request body too large." } });
      req.destroy();
      return;
    }
    let parsed: RenderRequest;
    try {
      const r = renderRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!r.success) throw new Error("invalid");
      parsed = r.data;
      const proto = new URL(parsed.url).protocol;
      if (proto !== "http:" && proto !== "https:") throw new Error("scheme");
    } catch {
      send(res, 400, { error: { code: "invalid_request", message: "Invalid render request." } });
      return;
    }
    if (busy >= opts.capacity) {
      send(res, 429, { error: { code: "busy", message: "All browser slots are in use. Retry shortly." } }, { "retry-after": "5" });
      return;
    }
    busy++;
    const started = Date.now();
    try {
      const result = await opts.renderer(parsed);
      send(res, 200, result);
      log(`render ${result.ok ? "ok" : (result.error?.code ?? "failed")} in ${Date.now() - started} ms`);
    } catch {
      // Never leak internals (stack traces, paths) to the caller.
      send(res, 500, { error: { code: "internal", message: "The render failed unexpectedly." } });
      log(`render crashed after ${Date.now() - started} ms`);
    } finally {
      busy--;
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  return Object.assign(server, { busy: () => busy });
}
