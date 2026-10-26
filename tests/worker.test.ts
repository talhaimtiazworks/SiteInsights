import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkerServer, type Renderer } from "../worker/src/app";
import { resolveAllowed, startEgressProxy } from "../worker/src/egress-proxy";
import { RENDER_PROTOCOL_VERSION, type RenderResult } from "@/lib/browser/protocol";
import { renderPage } from "@/lib/browser/client";

/**
 * Browser worker: HTTP front end (auth, validation, capacity, error hygiene)
 * and the egress proxy that enforces SSRF rules for everything Chromium loads.
 * These tests need no browser; tests/worker-render.integration.test.ts runs
 * real Chromium when it is installed.
 */

const TOKEN = "test-token-0123456789abcdefghij";

function fakeResult(url: string, over: Partial<RenderResult> = {}): RenderResult {
  return {
    version: RENDER_PROTOCOL_VERSION,
    ok: true,
    url,
    finalUrl: url,
    status: 200,
    viewport: { name: "mobile", width: 390, height: 844 },
    readiness: "network_idle",
    timing: { navigationMs: 10, totalMs: 20 },
    error: null,
    dom: { title: "T", metaDescription: null, canonical: null, robotsMeta: null, lang: "en", h1: [], wordCount: 10, htmlBytes: 100, jsonLdCount: 0, viewportMeta: null },
    links: [],
    linksTotal: 0,
    images: [],
    console: [],
    consoleTotal: 0,
    failedRequests: [],
    failedRequestsTotal: 0,
    requestCount: 1,
    blockedRequestCount: 0,
    requestBudgetExceeded: false,
    mobile: null,
    axe: null,
    axeError: null,
    ...over,
  };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

describe("worker HTTP server", () => {
  let base = "";
  let release: (() => void) | null = null;
  const calls: string[] = [];
  const renderer: Renderer = async (req) => {
    calls.push(req.url);
    if (req.url.includes("slow")) await new Promise<void>((r) => (release = r));
    if (req.url.includes("boom")) throw new Error("secret internal path /srv/worker/render.ts:42");
    return fakeResult(req.url);
  };
  const server = createWorkerServer({ token: TOKEN, renderer, capacity: 1 });
  beforeAll(async () => {
    base = await listen(server);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/v1/render`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const valid = { url: "https://example.com/", siteHosts: ["example.com"] };

  it("refuses to start with a weak token", () => {
    expect(() => createWorkerServer({ token: "short", renderer, capacity: 1 })).toThrow();
  });

  it("serves unauthenticated liveness only; everything else needs the token", async () => {
    expect((await fetch(`${base}/livez`)).status).toBe(200);
    expect((await fetch(`${base}/healthz`)).status).toBe(401);
    expect((await post(valid, { authorization: "Bearer wrong-token-0123456789abcdef" })).status).toBe(401);
    expect((await post(valid, { authorization: "" })).status).toBe(401);
    const h = await fetch(`${base}/healthz`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ ok: true, capacity: 1 });
  });

  it("validates requests (schema, scheme, content type, size)", async () => {
    expect((await post({ url: "not a url", siteHosts: ["x.com"] })).status).toBe(400);
    expect((await post({ url: "file:///etc/passwd", siteHosts: ["x.com"] })).status).toBe(400);
    expect((await post({ ...valid, navigationTimeoutMs: 999_999 })).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
    expect((await post(valid, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post({ ...valid, pad: "x".repeat(70_000) })).status).toBe(413);
  });

  it("renders a valid request", async () => {
    const res = await post(valid);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("rejects work beyond capacity with 429 instead of queueing", async () => {
    const slow = post({ ...valid, url: "https://example.com/slow" });
    while (!release) await new Promise((r) => setTimeout(r, 5));
    const busy = await post(valid);
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("5");
    release!();
    expect((await slow).status).toBe(200);
  });

  it("never leaks internal error details", async () => {
    const res = await post({ ...valid, url: "https://example.com/boom" });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/srv|render\.ts|secret/);
  });

  it("app client: maps worker failures without blaming the website", async () => {
    const opts = { workerUrl: base, token: TOKEN, timeoutMs: 5000 };
    const ok = await renderPage(valid, opts);
    expect(ok.ok).toBe(true);
    const bad = await renderPage(valid, { ...opts, token: "wrong-token-0123456789abcdef" });
    expect(bad).toMatchObject({ ok: false, code: "worker_auth" });
    const down = await renderPage(valid, { ...opts, workerUrl: "http://127.0.0.1:1" });
    expect(down).toMatchObject({ ok: false, code: "worker_unavailable" });
    const malformed = await renderPage(valid, { ...opts, fetchImpl: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch });
    expect(malformed).toMatchObject({ ok: false, code: "invalid_response" });
    const slow = await renderPage(valid, { ...opts, timeoutMs: 50, fetchImpl: ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch });
    expect(slow).toMatchObject({ ok: false, code: "worker_timeout" });
  });
});

describe("egress policy (SSRF protection for everything the browser loads)", () => {
  const pub = async () => [{ address: "93.184.216.34", family: 4 }];
  const policy = { allowedPorts: [80, 443], lookup: pub };

  it("allows public destinations on allowed ports", async () => {
    expect(await resolveAllowed("example.com", 443, policy)).toEqual({ ok: true, ip: "93.184.216.34" });
  });

  it.each([
    ["localhost", 80],
    ["app.localhost", 80],
    ["printer.local", 80],
    ["127.0.0.1", 80],
    ["10.1.2.3", 443],
    ["192.168.0.10", 80],
    ["169.254.169.254", 80],
    ["[::1]", 443],
    ["[fd00::1]", 443],
    ["100.64.0.1", 80],
    ["0.0.0.0", 80],
  ])("blocks %s:%i", async (host, port) => {
    expect((await resolveAllowed(host, port, policy)).ok).toBe(false);
  });

  it("blocks disallowed ports even for public hosts", async () => {
    expect(await resolveAllowed("example.com", 22, policy)).toMatchObject({ ok: false });
    expect(await resolveAllowed("example.com", 6379, policy)).toMatchObject({ ok: false });
  });

  it("blocks hosts where ANY DNS answer is private (rebinding-style records)", async () => {
    const mixed = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    expect(await resolveAllowed("rebind.example.com", 443, { ...policy, lookup: mixed })).toMatchObject({ ok: false });
    const v6 = async () => [{ address: "::ffff:10.0.0.1", family: 6 }];
    expect(await resolveAllowed("mapped.example.com", 443, { ...policy, lookup: v6 })).toMatchObject({ ok: false });
    const fail = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await resolveAllowed("nx.example.com", 443, { ...policy, lookup: fail })).toMatchObject({ ok: false });
  });
});

describe("egress proxy", () => {
  let upstream: http.Server;
  let upstreamPort = 0;
  const seen: string[] = [];
  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      seen.push(`${req.headers.host} ${req.url}`);
      res.writeHead(200, { "content-type": "text/plain" }).end("hello from upstream");
    });
    await listen(upstream);
    upstreamPort = (upstream.address() as net.AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

  function viaProxy(proxyPort: number, absoluteUrl: string): Promise<{ status: number; body: string; blocked: string | undefined }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: absoluteUrl, headers: { host: new URL(absoluteUrl).host } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, blocked: res.headers["x-sitelens-blocked"] as string | undefined }));
      });
      req.on("error", reject);
      req.end();
    });
  }
  function connect(proxyPort: number, authority: string): Promise<string> {
    return new Promise((resolve) => {
      const s = net.connect(proxyPort, "127.0.0.1", () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
      s.once("data", (d) => {
        resolve(d.toString().split("\r\n")[0]);
        s.destroy();
      });
    });
  }

  it("connects to the validated IP, not to a fresh DNS answer", async () => {
    // The fake host resolves to the local upstream; loopback is allowed only for this test.
    let lookups = 0;
    const proxy = await startEgressProxy({ allowedPorts: [upstreamPort], lookup: async () => (lookups++, [{ address: "127.0.0.1", family: 4 }]), isAllowedAddress: (ip) => ip === "127.0.0.1" });
    try {
      const r = await viaProxy(proxy.port, `http://site.fixture-sitelens.com:${upstreamPort}/page?q=1`);
      expect(r.status).toBe(200);
      expect(r.body).toBe("hello from upstream");
      expect(seen.at(-1)).toBe(`site.fixture-sitelens.com:${upstreamPort} /page?q=1`);
      expect(lookups).toBe(1);
    } finally {
      await proxy.close();
    }
  });

  it("refuses private destinations for plain HTTP and CONNECT tunnels, and records them", async () => {
    const blocked: string[] = [];
    const proxy = await startEgressProxy({ allowedPorts: [80, 443, upstreamPort], onBlocked: (h) => blocked.push(h) });
    try {
      const r = await viaProxy(proxy.port, `http://127.0.0.1:${upstreamPort}/secret`);
      expect(r.status).toBe(403);
      expect(r.blocked).toBe("1");
      expect(r.body).not.toContain("hello");
      expect(await connect(proxy.port, "169.254.169.254:443")).toContain("403");
      expect(await connect(proxy.port, "localhost:443")).toContain("403");
      expect(await connect(proxy.port, "example.com:22")).toContain("403");
      expect(blocked).toEqual(expect.arrayContaining(["127.0.0.1", "169.254.169.254", "localhost", "example.com"]));
      expect(proxy.blockedHosts.has("169.254.169.254")).toBe(true);
      expect(seen.some((s) => s.includes("/secret"))).toBe(false);
    } finally {
      await proxy.close();
    }
  });
});
