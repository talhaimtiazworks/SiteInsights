import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium, type Browser, type Page } from "playwright-core";
import { RENDER_CAPS, RENDER_PROTOCOL_VERSION, renderResultSchema, type RenderRequest, type RenderResult } from "../../src/lib/browser/protocol";
import { resolveAllowed, startEgressProxy, type EgressPolicy } from "./egress-proxy";

/**
 * Renders one page in an isolated headless Chromium.
 *
 * Isolation: a fresh browser process per render (no shared profile, cache or
 * cookies between sites), killed when done or on timeout. Network: forced
 * through the egress proxy (see egress-proxy.ts); Chromium cannot resolve DNS
 * itself, loopback is not bypassed, QUIC is off and WebRTC may not use
 * non-proxied UDP. Service workers and downloads are blocked, and a request
 * budget is enforced with request interception.
 */

export interface RendererOptions {
  executablePath?: string;
  /** Extra hard limit on top of the navigation timeout. */
  overheadMs?: number;
  policyOverrides?: Pick<EgressPolicy, "lookup" | "isAllowedAddress">;
}

const require = createRequire(import.meta.url);
let axeSource: string | null = null;
function getAxeSource(): string {
  axeSource ??= readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  return axeSource;
}

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1366, height: 900 };
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const t = (s: unknown, max: number): string => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const tn = (s: unknown, max: number): string | null => (s === null || s === undefined || s === "" ? null : t(s, max));

function emptyResult(req: RenderRequest, started: number): RenderResult {
  const vp = req.viewport === "desktop" ? DESKTOP : MOBILE;
  return {
    version: RENDER_PROTOCOL_VERSION,
    ok: false,
    url: req.url,
    finalUrl: null,
    status: null,
    viewport: { name: req.viewport, ...vp },
    readiness: "none",
    timing: { navigationMs: null, totalMs: Date.now() - started },
    error: null,
    dom: null,
    links: [],
    linksTotal: 0,
    images: [],
    console: [],
    consoleTotal: 0,
    failedRequests: [],
    failedRequestsTotal: 0,
    requestCount: 0,
    blockedRequestCount: 0,
    requestBudgetExceeded: false,
    mobile: null,
    axe: null,
    axeError: null,
  };
}

/** Runs inside the page. Must be self-contained (no closures over Node values). */
function collect(args: { siteHosts: string[]; caps: typeof RENDER_CAPS; mobile: boolean }) {
  const { siteHosts, caps } = args;
  const clean = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, "");
  const internal = (h: string) => siteHosts.some((s) => strip(h) === strip(s) || strip(h).endsWith(`.${strip(s)}`) || strip(s).endsWith(`.${strip(h)}`));
  const selector = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    for (let i = 0; cur && i < 3; i++) {
      if (cur.id && /^[A-Za-z][\w-]{0,40}$/.test(cur.id)) {
        parts.unshift(`#${cur.id}`);
        break;
      }
      let part = cur.tagName.toLowerCase();
      const cls = [...cur.classList].filter((c) => /^[A-Za-z_][\w-]{0,30}$/.test(c)).slice(0, 2);
      if (cls.length) part += `.${cls.join(".")}`;
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(" > ").slice(0, 300);
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0;
  };

  const meta = (name: string) => document.querySelector(`meta[name="${name}" i]`)?.getAttribute("content") ?? null;
  const canonicalEl = [...document.querySelectorAll("link[rel]")].find((l) => (l.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")) as HTMLLinkElement | undefined;
  const robots = [...document.querySelectorAll("meta[name]")].filter((m) => ["robots", "sitelensai"].includes((m.getAttribute("name") ?? "").toLowerCase())).map((m) => m.getAttribute("content") ?? "").join(", ");
  const bodyText = document.body?.innerText ?? "";
  const words = bodyText.trim() ? bodyText.trim().split(/\s+/).length : 0;

  const seen = new Set<string>();
  const links: Array<{ url: string; text: string; internal: boolean; nofollow: boolean }> = [];
  let linksTotal = 0;
  for (const a of document.querySelectorAll("a[href]")) {
    const href = (a as HTMLAnchorElement).href;
    if (!/^https?:/i.test(href)) continue;
    let u: URL;
    try {
      u = new URL(href);
    } catch {
      continue;
    }
    u.hash = "";
    const key = u.toString();
    linksTotal++;
    if (seen.has(key) || links.length >= caps.links) continue;
    seen.add(key);
    links.push({ url: key.slice(0, 2048), text: clean((a as HTMLElement).innerText || a.getAttribute("aria-label") || a.getAttribute("title"), 100), internal: internal(u.hostname), nofollow: /\bnofollow\b/i.test(a.getAttribute("rel") ?? "") });
  }

  const images: Array<{ src: string; alt: string | null; broken: boolean }> = [];
  const seenImg = new Set<string>();
  for (const img of document.querySelectorAll("img")) {
    const src = img.currentSrc || img.src;
    if (!src || !/^https?:/i.test(src) || seenImg.has(src) || images.length >= caps.images) continue;
    seenImg.add(src);
    images.push({ src: src.slice(0, 2048), alt: img.hasAttribute("alt") ? clean(img.getAttribute("alt"), 150) : null, broken: img.complete && img.naturalWidth === 0 });
  }

  let mobile = null;
  if (args.mobile) {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const sw = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
    const all = [...document.body.querySelectorAll("*")].slice(0, 4000);
    const overflowing: Array<{ selector: string; right: number }> = [];
    if (sw > vw + 2) {
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.right > vw + 2 && r.width > 0 && r.width <= sw && visible(el)) {
          // Report the outermost overflowing elements only.
          if (el.parentElement && el.parentElement.getBoundingClientRect().right > vw + 2 && el.parentElement !== document.body) continue;
          overflowing.push({ selector: selector(el), right: Math.round(r.right) });
          if (overflowing.length >= caps.overflow) break;
        }
      }
    }
    const targets = [...document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link]")].filter(visible).slice(0, 1500);
    const small: Array<{ selector: string; text: string; width: number; height: number }> = [];
    let smallTotal = 0;
    for (const el of targets) {
      const cs = getComputedStyle(el);
      // Inline links inside running text are exempt (WCAG 2.5.8 "inline" exception).
      if (el.tagName === "A" && cs.display === "inline" && (el.parentElement?.innerText ?? "").trim().length > ((el as HTMLElement).innerText ?? "").trim().length + 5) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) {
        smallTotal++;
        if (small.length < caps.tapTargets) small.push({ selector: selector(el), text: clean((el as HTMLElement).innerText || el.getAttribute("aria-label"), 100), width: Math.round(r.width), height: Math.round(r.height) });
      }
    }
    let textChecked = 0;
    let smallText = 0;
    const smallSamples: Array<{ selector: string; fontSize: number; text: string }> = [];
    for (const el of all) {
      if (textChecked >= 2500) break;
      const direct = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? "").join("").trim();
      if (direct.length < 3 || !visible(el)) continue;
      textChecked++;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 12) {
        smallText++;
        if (smallSamples.length < caps.smallText) smallSamples.push({ selector: selector(el), fontSize: Math.round(fs * 10) / 10, text: clean(direct, 100) });
      }
    }
    mobile = { viewportWidth: vw, scrollWidth: sw, horizontalOverflow: sw > vw + 2, overflowing, tapTargetsChecked: targets.length, smallTapTargets: small, smallTapTargetsTotal: smallTotal, textNodesChecked: textChecked, smallTextTotal: smallText, smallText: smallSamples };
  }

  return {
    dom: {
      title: clean(document.title, 300) || null,
      metaDescription: meta("description") !== null ? clean(meta("description"), 500) : null,
      canonical: canonicalEl?.href ? canonicalEl.href.slice(0, 2048) : null,
      robotsMeta: robots ? clean(robots, 200).toLowerCase() : null,
      lang: clean(document.documentElement.getAttribute("lang"), 40) || null,
      h1: [...document.querySelectorAll("h1")].slice(0, 10).map((h) => clean((h as HTMLElement).innerText, 160)),
      wordCount: words,
      htmlBytes: document.documentElement.outerHTML.length,
      jsonLdCount: document.querySelectorAll('script[type="application/ld+json" i]').length,
      viewportMeta: meta("viewport") !== null ? clean(meta("viewport"), 300) : null,
    },
    links,
    linksTotal,
    images,
    mobile,
  };
}

/**
 * Runs a self-contained function in the page. The function is sent as source
 * text inside a closure that defines a no-op `__name`: tsx/esbuild (keepNames)
 * inserts `__name(fn, "name")` calls into compiled functions, and that helper
 * does not exist in the page. Defining it locally (not as a page global) keeps
 * page scripts from interfering. Arguments must be JSON-serialisable.
 */
export function inPage<A, R>(page: Page, fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> {
  const source = `(() => { const __name = (f) => f; return (${fn.toString()})(${JSON.stringify(arg)}); })()`;
  return page.evaluate(source) as Promise<R>;
}

async function runAxe(page: Page, timeoutMs: number): Promise<RenderResult["axe"]> {
  await page.addScriptTag({ content: getAxeSource() });
  let axeTimer: ReturnType<typeof setTimeout> | undefined;
  const raw = await Promise.race([
    inPage(page, async (tags: string[]) => {
      // @ts-expect-error axe is injected above
      const r = await window.axe.run(document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"], elementRef: false });
      // @ts-expect-error axe is injected above
      return { version: String(window.axe.version), violations: r.violations, passes: r.passes.length, incomplete: r.incomplete.length };
    }, AXE_TAGS),
    new Promise<never>((_, reject) => {
      axeTimer = setTimeout(() => reject(new Error("axe timed out")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(axeTimer));
  type RawNode = { target?: unknown[]; html?: string; failureSummary?: string };
  type RawViolation = { id: string; impact?: string | null; help?: string; description?: string; helpUrl?: string; tags?: string[]; nodes?: RawNode[] };
  return {
    version: t(raw.version, 20),
    passes: raw.passes,
    incomplete: raw.incomplete,
    violations: (raw.violations as RawViolation[]).slice(0, RENDER_CAPS.axeViolations).map((v) => ({
      id: t(v.id, 100),
      impact: (["minor", "moderate", "serious", "critical"].includes(String(v.impact)) ? v.impact : null) as "minor" | "moderate" | "serious" | "critical" | null,
      help: t(v.help, 300),
      description: t(v.description, 1000),
      helpUrl: t(v.helpUrl, 500),
      tags: (v.tags ?? []).slice(0, 30).map((x) => t(x, 60)),
      nodeCount: v.nodes?.length ?? 0,
      nodes: (v.nodes ?? []).slice(0, RENDER_CAPS.axeNodes).map((n) => ({
        target: (n.target ?? []).slice(0, 5).map((x) => t(Array.isArray(x) ? x.join(" ") : x, 500)),
        html: t(n.html, RENDER_CAPS.html),
        failureSummary: tn(n.failureSummary, 1000),
      })),
    })),
  };
}

export function createRenderer(opts: RendererOptions = {}) {
  let browserVersion: string | null = null;

  async function render(req: RenderRequest): Promise<RenderResult> {
    const started = Date.now();
    const out = emptyResult(req, started);
    const target = new URL(req.url);
    const port = target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
    const policy: EgressPolicy = { allowedPorts: req.allowedPorts, ...opts.policyOverrides };
    const pre = await resolveAllowed(target.hostname, port, policy);
    if (!pre.ok) {
      out.error = { code: "blocked_destination", message: `The URL was not rendered: ${pre.reason}.` };
      return finish(out, started);
    }

    const proxy = await startEgressProxy(policy);
    let browser: Browser | null = null;
    const hardLimit = req.navigationTimeoutMs + (opts.overheadMs ?? 30_000);
    let timer: NodeJS.Timeout | null = null;
    try {
      const work = (async () => {
        browser = await chromium.launch({
          headless: true,
          executablePath: opts.executablePath,
          proxy: { server: proxy.url, bypass: "<-loopback>" },
          args: [
            "--disable-quic",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            "--webrtc-ip-handling-policy=disable_non_proxied_udp",
            "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-domain-reliability",
            "--disable-sync",
            "--no-first-run",
            "--disable-dev-shm-usage",
            "--disable-features=Translate,MediaRouter,OptimizationHints,DnsOverHttps,PrivateNetworkAccessSendPreflights",
          ],
        });
        browserVersion = (browser as Browser).version();
        const vp = req.viewport === "desktop" ? DESKTOP : MOBILE;
        const mobile = req.viewport === "mobile";
        const ua = mobile
          ? `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion.split(".")[0]}.0.0.0 Mobile Safari/537.36 ${req.userAgent ?? "SiteLensAI"}`
          : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion.split(".")[0]}.0.0.0 Safari/537.36 ${req.userAgent ?? "SiteLensAI"}`;
        const context = await (browser as Browser).newContext({
          viewport: vp,
          isMobile: mobile,
          hasTouch: mobile,
          deviceScaleFactor: 1,
          userAgent: ua.trim(),
          serviceWorkers: "block",
          acceptDownloads: false,
          bypassCSP: !!req.accessibility, // needed to inject axe-core
          ignoreHTTPSErrors: false,
          javaScriptEnabled: true,
          permissions: [],
        });
        const page = await context.newPage();
        page.setDefaultTimeout(req.navigationTimeoutMs);

        let requests = 0;
        await page.route("**/*", (route) => {
          requests++;
          if (requests > req.maxRequests) {
            out.requestBudgetExceeded = true;
            return route.abort("blockedbyclient");
          }
          return route.continue();
        });

        const failed: RenderResult["failedRequests"] = [];
        let failedTotal = 0;
        const consoleMsgs: RenderResult["console"] = [];
        let consoleTotal = 0;
        page.on("console", (m) => {
          const kind = m.type() === "error" ? "error" : m.type() === "warning" ? "warning" : null;
          if (!kind) return;
          consoleTotal++;
          if (consoleMsgs.length < RENDER_CAPS.console) consoleMsgs.push({ kind, text: t(m.text(), RENDER_CAPS.text), source: tn(m.location()?.url, 2048) });
        });
        page.on("pageerror", (e) => {
          consoleTotal++;
          if (consoleMsgs.length < RENDER_CAPS.console) consoleMsgs.push({ kind: "pageerror", text: t(`${e.name}: ${e.message}`, RENDER_CAPS.text), source: null });
        });
        const blockedHost = (u: string) => {
          try {
            return proxy.blockedHosts.has(new URL(u).hostname.toLowerCase());
          } catch {
            return false;
          }
        };
        page.on("requestfailed", (r) => {
          failedTotal++;
          const failure = r.failure()?.errorText ?? null;
          const safety = blockedHost(r.url()) || (out.requestBudgetExceeded && /BLOCKED_BY_CLIENT/i.test(failure ?? ""));
          if (failed.length < RENDER_CAPS.failedRequests) failed.push({ url: t(r.url(), 2048), resourceType: t(r.resourceType(), 30), status: null, failure: tn(failure, 200), blockedBySafety: safety });
        });
        page.on("response", (r) => {
          if (r.status() < 400 || r.request().isNavigationRequest()) return;
          failedTotal++;
          if (failed.length < RENDER_CAPS.failedRequests) failed.push({ url: t(r.url(), 2048), resourceType: t(r.request().resourceType(), 30), status: r.status(), failure: null, blockedBySafety: r.headers()["x-sitelens-blocked"] === "1" });
        });
        let crashed = false;
        page.on("crash", () => (crashed = true));

        // Navigation with a readiness ladder: DOMContentLoaded → load → network idle.
        const navStart = Date.now();
        let response;
        try {
          response = await page.goto(req.url, { waitUntil: "domcontentloaded", timeout: req.navigationTimeoutMs });
          out.readiness = "dom_content_loaded";
        } catch (e) {
          const msg = String((e as Error)?.message ?? "");
          if (blockedHost(req.url) || /ERR_TUNNEL_CONNECTION_FAILED/.test(msg)) out.error = { code: "blocked_destination", message: "The page (or a redirect) points to a destination SiteInsight does not access." };
          else if (/Timeout/i.test(msg)) out.error = { code: "navigation_timeout", message: `The page did not finish loading within ${Math.round(req.navigationTimeoutMs / 1000)} s.` };
          else out.error = { code: "navigation_failed", message: t(msg.split("\n")[0].replace(/^page\.goto:\s*/, ""), 300) || "Navigation failed." };
          return;
        }
        const remaining = () => Math.max(0, req.navigationTimeoutMs - (Date.now() - navStart));
        try {
          await page.waitForLoadState("load", { timeout: remaining() });
          out.readiness = "load";
          await page.waitForLoadState("networkidle", { timeout: Math.min(5000, remaining()) });
          out.readiness = "network_idle";
        } catch {
          /* keep the best readiness reached: long-polling or trackers often prevent network idle */
        }
        if (req.settleMs) await page.waitForTimeout(req.settleMs);
        out.timing.navigationMs = Date.now() - navStart;
        out.finalUrl = t(page.url(), 2048);
        out.status = response?.status() ?? null;
        const ct = response?.headers()["content-type"] ?? "";
        if (response?.headers()["x-sitelens-blocked"] === "1" || blockedHost(out.finalUrl)) {
          out.error = { code: "blocked_destination", message: "The page (or a redirect) points to a destination SiteInsight does not access." };
        } else if (out.status !== null && out.status >= 400) {
          out.error = { code: "http_error", message: `The page returned HTTP ${out.status} in the browser.` };
        } else if (ct && !/text\/html|application\/xhtml\+xml/i.test(ct)) {
          out.error = { code: "not_html", message: `The page is not HTML (${t(ct, 60)}).` };
        }
        if (!out.error) {
          const data = await inPage(page, collect, { siteHosts: req.siteHosts, caps: RENDER_CAPS, mobile });
          out.dom = data.dom;
          out.links = data.links;
          out.linksTotal = data.linksTotal;
          out.images = data.images;
          out.mobile = data.mobile;
          if (req.accessibility) {
            try {
              out.axe = await runAxe(page, Math.min(25_000, Math.max(8000, remaining() + 10_000)));
            } catch (e) {
              out.axeError = t((e as Error)?.message ?? "axe-core failed", 300);
            }
          }
          out.ok = true;
        }
        if (crashed) {
          out.ok = false;
          out.error = { code: "crashed", message: "The browser tab crashed while loading the page." };
        }
        out.console = consoleMsgs;
        out.consoleTotal = consoleTotal;
        out.failedRequests = failed;
        out.failedRequestsTotal = failedTotal;
        out.requestCount = requests;
      })();
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            out.ok = false;
            out.error = { code: "navigation_timeout", message: `Rendering exceeded the ${Math.round(hardLimit / 1000)} s limit.` };
            resolve();
          }, hardLimit);
        }),
      ]);
    } catch (e) {
      // Operator log only (first line, truncated); never returned to the app.
      console.error(`[worker] render error: ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300)}`);
      out.ok = false;
      out.error = { code: "crashed", message: t(/Target (page|closed)|crash/i.test(String((e as Error)?.message)) ? "The browser crashed while loading the page." : "The browser failed while loading the page.", 300) };
    } finally {
      if (timer) clearTimeout(timer);
      out.blockedRequestCount = proxy.blockedHosts.size ? Math.max(out.failedRequests.filter((f) => f.blockedBySafety).length, 1) : 0;
      await (browser as Browser | null)?.close().catch(() => {});
      await proxy.close().catch(() => {});
    }
    return finish(out, started);
  }

  function finish(out: RenderResult, started: number): RenderResult {
    out.timing.totalMs = Date.now() - started;
    // Validate our own output so the app never receives an out-of-contract reply.
    return renderResultSchema.parse(out);
  }

  return { render, browserVersion: () => browserVersion };
}
