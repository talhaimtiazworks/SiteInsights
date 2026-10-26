/**
 * Route-level test harness: runs the real Next.js route handlers and the real
 * proxy.ts logic with a simulated browser (cookie jar + scan-key storage).
 *
 * `next/headers` cookies() is backed by an AsyncLocalStorage holding the
 * current request, so concurrent requests stay isolated. Test files must call
 * `vi.mock("next/headers", () => nextHeadersMock)` (see scan-lifecycle tests).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

interface RequestStore {
  cookies: Map<string, string>;
  setCookies: Array<{ name: string; value: string }>;
}
export const requestStore = new AsyncLocalStorage<RequestStore>();

export const nextHeadersMock = {
  cookies: async () => {
    const store = requestStore.getStore();
    if (!store) throw new Error("cookies() called outside a request");
    return {
      get: (name: string) => (store.cookies.has(name) ? { name, value: store.cookies.get(name)! } : undefined),
      set: (name: string, value: string) => {
        store.cookies.set(name, value);
        store.setCookies.push({ name, value });
      },
    };
  },
  headers: async () => new Headers(),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route handlers have differently-typed params
type Handler = (req: NextRequest, ctx: { params: Promise<any> }) => Promise<Response>;

export interface CallResult<T = unknown> {
  status: number;
  body: { ok: boolean; data?: T; error?: { code: string; message: string; details?: Record<string, unknown> } };
  headers: Headers;
  /** Raw response body (for binary responses such as PDFs). */
  bytes: Uint8Array;
}

const ORIGIN = "http://sitelens.localtest";

function parseCookieHeader(h: string | null): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (h ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return m;
}

/** A simulated browser: keeps cookies and scan access keys between requests. */
export class TestBrowser {
  cookies = new Map<string, string>();
  scanKeys = new Map<string, string>();

  private static n = 0;
  /** Random per test file: files run in parallel and must not share per-IP limits. */
  private static net = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  /** Each simulated browser gets its own client IP so per-IP throttles don't interfere between tests. */
  ip: string;

  constructor(public name = "browser") {
    TestBrowser.n++;
    this.ip = `${TestBrowser.net}.${TestBrowser.n % 250}`;
  }

  clearCookies() {
    this.cookies.clear();
  }

  /** Simulates a page navigation (only proxy.ts runs, like a static page load). */
  async visit(path = "/") {
    const req = new NextRequest(`${ORIGIN}${path}`, { headers: this.cookieHeaders() });
    const res = await proxy(req);
    this.absorbSetCookie(res.headers);
  }

  async call<T = unknown>(
    handler: Handler,
    method: string,
    path: string,
    opts: { json?: unknown; params?: Record<string, string>; headers?: Record<string, string>; sendScanKey?: boolean } = {},
  ): Promise<CallResult<T>> {
    const headers: Record<string, string> = { "x-real-ip": this.ip, ...this.cookieHeaders(), ...opts.headers };
    if (method !== "GET") {
      headers["origin"] = ORIGIN;
      headers["sec-fetch-site"] = "same-origin";
    }
    const scanId = opts.params?.id;
    if (scanId && opts.sendScanKey !== false && this.scanKeys.has(scanId)) headers["x-scan-key"] = this.scanKeys.get(scanId)!;
    if (opts.json !== undefined) headers["content-type"] = "application/json";
    const init = { method, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined };

    // 1) proxy.ts, exactly as Next.js applies it: forwarded request headers + response cookies.
    const pre = new NextRequest(`${ORIGIN}${path}`, init);
    const proxied = await proxy(pre);
    const fwdHeaders = new Headers(pre.headers);
    const overridden = proxied.headers.get("x-middleware-override-headers");
    if (overridden) {
      for (const name of overridden.split(",")) {
        const v = proxied.headers.get(`x-middleware-request-${name}`);
        if (v === null) fwdHeaders.delete(name);
        else fwdHeaders.set(name, v);
      }
    }
    this.absorbSetCookie(proxied.headers);

    // 2) the route handler, with cookies() bound to this request.
    const req = new NextRequest(`${ORIGIN}${path}`, { ...init, headers: fwdHeaders });
    const store: RequestStore = { cookies: parseCookieHeader(fwdHeaders.get("cookie")), setCookies: [] };
    const res = await requestStore.run(store, () => handler(req, { params: Promise.resolve(opts.params ?? {}) }));
    for (const c of store.setCookies) this.cookies.set(c.name, c.value);
    this.absorbSetCookie(res.headers);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    let body: CallResult<T>["body"];
    try {
      body = JSON.parse(text);
    } catch {
      body = { ok: false, error: { code: "non_json", message: text.slice(0, 200) } };
    }
    return { status: res.status, body, headers: res.headers, bytes };
  }

  private cookieHeaders(): Record<string, string> {
    return this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {};
  }

  private absorbSetCookie(h: Headers) {
    for (const line of h.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!value || /;\s*max-age=0/i.test(line) || /;\s*expires=thu, 01 jan 1970/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}
