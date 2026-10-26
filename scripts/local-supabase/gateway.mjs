/**
 * Minimal local stand-in for the Supabase API gateway: serves a GoTrue
 * (Supabase Auth) server under /auth/v1, the path layout supabase-js expects.
 * GATEWAY_PORT (default 54321) → GOTRUE_URL (default http://127.0.0.1:9999).
 * Development/test only.
 */
import http from "node:http";

const PORT = Number(process.env.GATEWAY_PORT ?? 54321);
const target = new URL(process.env.GOTRUE_URL ?? "http://127.0.0.1:9999");

http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://gateway");
  if (!url.pathname.startsWith("/auth/v1")) return void res.writeHead(404, { "content-type": "application/json" }).end('{"message":"not found"}');
  const upstreamPath = url.pathname.slice("/auth/v1".length) || "/";
  const headers = { ...req.headers, host: target.host };
  const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: upstreamPath + url.search, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502).end('{"message":"auth server unavailable"}'); });
  req.pipe(up);
}).listen(PORT, "127.0.0.1", () => console.log(`[gateway] http://127.0.0.1:${PORT}/auth/v1 → ${target.origin}`));
