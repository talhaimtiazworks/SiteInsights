import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RenderRequestInput, RenderResult } from "@/lib/browser/protocol";
import { renderRequestSchema } from "@/lib/browser/protocol";

/**
 * Real headless Chromium against a local fixture site. Runs only when the
 * worker dependencies (cd worker && npm install) and a Playwright Chromium
 * build are installed; otherwise the suite is reported as skipped.
 *
 * The fixture is reached through the fake public host name
 * site.fixture-sitelens.com → 127.0.0.2 (the only address the test policy
 * allows). Everything else on loopback/private/metadata must be blocked.
 */

type RendererModule = { createRenderer: (o: unknown) => { render: (r: ReturnType<typeof renderRequestSchema.parse>) => Promise<RenderResult> } };

let mod: RendererModule | null = null;
let chromiumOk = false;
try {
  const pwPath = "../worker/node_modules/playwright-core/index.js";
  const pw = (await import(/* @vite-ignore */ pwPath)) as { chromium: { executablePath(): string } };
  chromiumOk = existsSync(pw.chromium.executablePath()) || existsSync(pw.chromium.executablePath().replace("chromium-", "chromium_headless_shell-"));
  const renderPath = "../worker/src/render.ts";
  mod = (await import(/* @vite-ignore */ renderPath)) as RendererModule;
} catch {
  mod = null;
}
const available = !!mod && chromiumOk;

const HOST = "site.fixture-sitelens.com";
let port = 0;
let secretHits = 0;
let server: http.Server;

const PAGE = (p: number) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Loading</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><p>Loading…</p><div id="app"></div>
<script>
  document.title = "Rendered title";
  var app = document.getElementById("app");
  var words = []; for (var i = 0; i < 220; i++) words.push("word" + i);
  app.innerHTML = '<h1>Client rendered</h1><p>' + words.join(" ") + '</p>' +
    ['a','b','c','d','e','f'].map(function (x) { return '<a href="/js-' + x + '">Link ' + x + '</a> '; }).join("") +
    '<img src="/missing.png">' +
    '<div style="width:900px;background:#eee">wide</div>' +
    '<button style="width:14px;height:14px;padding:0"></button>' +
    '<p style="color:#bbb;background:#fff">low contrast text here</p>';
  console.error("fixture console error");
  setTimeout(function () { throw new Error("fixture uncaught"); }, 10);
  // SSRF attempts from inside the page — all must be blocked by the egress proxy:
  new Image().src = "http://127.0.0.1:${p}/secret?img";
  new Image().src = "http://localhost:${p}/secret?localhost";
  fetch("http://169.254.169.254/latest/meta-data/").catch(function () {});
  fetch("http://10.0.0.1/").catch(function () {});
  fetch("http://${HOST}:22/").catch(function () {});
</script></body></html>`;

beforeAll(async () => {
  if (!available) return;
  server = http.createServer((req, res) => {
    const u = req.url ?? "/";
    if (u.startsWith("/secret")) {
      secretHits++;
      res.writeHead(200).end("secret");
      return;
    }
    if (u === "/") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE(port));
    if (u === "/redirect-metadata") return void res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    if (u === "/slow") return; // never answers
    if (u === "/many") return void res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>many</title><body><script>for (var i = 0; i < 40; i++) { var im = new Image(); im.src = "/img-" + i + ".png"; document.body.appendChild(im); }</script></body>`);
    if (u.startsWith("/js-")) return void res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>x</title><p>ok</p>");
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  // Listen on all loopback addresses so a missing block WOULD reach /secret.
  await new Promise<void>((r) => server.listen(0, "0.0.0.0", () => r()));
  port = (server.address() as net.AddressInfo).port;
}, 30_000);
afterAll(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

function renderer() {
  return mod!.createRenderer({
    overheadMs: 15_000,
    policyOverrides: {
      lookup: async (h: string) => (h === HOST ? [{ address: "127.0.0.2", family: 4 }] : [{ address: "203.0.113.10", family: 4 }]),
      isAllowedAddress: (ip: string) => ip === "127.0.0.2",
    },
  });
}
const req = (path: string, over: Partial<RenderRequestInput> = {}) => renderRequestSchema.parse({ url: `http://${HOST}:${port}${path}`, siteHosts: [HOST], allowedPorts: [port], navigationTimeoutMs: 8000, settleMs: 500, ...over });

describe.skipIf(!available)("browser worker with real Chromium", () => {
  it("renders client-side content and reports browser, mobile and axe findings", async () => {
    const r = await renderer().render(req("/", { accessibility: true }));
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);
    expect(r.dom?.title).toBe("Rendered title");
    expect(r.dom?.wordCount).toBeGreaterThan(200);
    expect(r.links.filter((l) => l.internal && l.url.includes("/js-")).length).toBe(6);
    expect(r.images.some((i) => i.src.endsWith("/missing.png") && i.broken)).toBe(true);
    expect(r.console.some((c) => c.kind === "error" && c.text.includes("fixture console error"))).toBe(true);
    expect(r.console.some((c) => c.kind === "pageerror" && c.text.includes("fixture uncaught"))).toBe(true);
    expect(r.failedRequests.some((f) => f.url.endsWith("/missing.png") && f.status === 404 && !f.blockedBySafety)).toBe(true);
    expect(r.mobile?.viewportWidth).toBe(390);
    expect(r.mobile?.horizontalOverflow).toBe(true);
    expect(r.mobile?.smallTapTargetsTotal).toBeGreaterThanOrEqual(1);
    expect(r.axe?.version).toMatch(/^4\./);
    const ids = r.axe!.violations.map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining(["image-alt", "color-contrast"]));
    const contrast = r.axe!.violations.find((v) => v.id === "color-contrast")!;
    expect(contrast.tags).toContain("wcag143");
    expect(contrast.nodes[0].target.length).toBeGreaterThan(0);
  }, 60_000);

  it("works when compiled by tsx like the production worker (in-page functions survive keepNames)", async () => {
    const tsx = "worker/node_modules/.bin/tsx";
    if (!existsSync(tsx)) return;
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(tsx, ["tests/fixtures/tsx-render.mts", `http://${HOST}:${port}/`, String(port), HOST], { timeout: 50_000 }, (err, out, errOut) => (err ? reject(new Error(`${err.message}\n${errOut}`)) : resolve(out))),
    );
    const r = JSON.parse(stdout) as { ok: boolean; error: unknown; title: string | null; links: number; axe: number | null };
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);
    expect(r.title).toBe("Rendered title");
    expect(r.links).toBeGreaterThanOrEqual(6);
    expect(r.axe).toBeGreaterThan(0);
  }, 60_000);

  it("blocks loopback, localhost, metadata, private and wrong-port requests made by the page", async () => {
    secretHits = 0;
    const r = await renderer().render(req("/"));
    expect(r.ok).toBe(true);
    expect(secretHits).toBe(0);
    const blocked = r.failedRequests.filter((f) => f.blockedBySafety).map((f) => new URL(f.url).hostname);
    expect(blocked).toEqual(expect.arrayContaining(["127.0.0.1", "localhost"]));
    expect(r.blockedRequestCount).toBeGreaterThan(0);
  }, 60_000);

  it("blocks redirects to internal destinations", async () => {
    const r = await renderer().render(req("/redirect-metadata"));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("blocked_destination");
  }, 60_000);

  it("refuses private targets before launching a browser", async () => {
    const r = await renderer().render(renderRequestSchema.parse({ url: "http://127.0.0.1/", siteHosts: ["127.0.0.1"], allowedPorts: [80] }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("blocked_destination");
  });

  it("times out gracefully on a page that never loads", async () => {
    const started = Date.now();
    const r = await renderer().render(req("/slow", { navigationTimeoutMs: 3000 }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("navigation_timeout");
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it("enforces the request budget", async () => {
    const r = await renderer().render(req("/many", { maxRequests: 10 }));
    expect(r.requestBudgetExceeded).toBe(true);
    expect(r.failedRequests.filter((f) => f.blockedBySafety).length).toBeGreaterThan(0);
  }, 60_000);
});
