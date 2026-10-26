import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { LookupFn } from "@/lib/security/safe-fetch";

export const SITE_HOST = "site.sitelens-fixture.com";
export const EXT_HOST = "ext.sitelens-fixture.net";
export const REBIND_HOST = "rebind.sitelens-fixture.com";
export const PRIVATE_HOST = "private.sitelens-fixture.com";
export const MISSING_HOST = "nxdomain.sitelens-fixture.com";

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "site");
const page = (name: string) => readFileSync(path.join(FIXTURE_DIR, name), "utf8");

export interface FixtureServer {
  port: number;
  origin: string;
  extOrigin: string;
  requests: Array<{ host: string; method: string; path: string; ua: string }>;
  close(): Promise<void>;
}

/**
 * Local HTTP server that impersonates two "public" websites (by Host header).
 * Tests point the scanner's DNS resolver at it via `fixtureLookup` and allow
 * only 127.0.0.1 via `fixturePolicy` — production code always uses real DNS
 * and the public-IP policy.
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: FixtureServer["requests"] = [];
  let port = 0;
  const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    const p = (req.url ?? "/").split("?")[0];
    requests.push({ host, method: req.method ?? "GET", path: req.url ?? "/", ua: String(req.headers["user-agent"] ?? "") });
    const origin = `http://${SITE_HOST}:${port}`;
    const html = (body: string, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(req.method === "HEAD" ? undefined : body.replaceAll("{{ORIGIN}}", origin).replaceAll("{{EXT}}", `http://${EXT_HOST}:${port}`));
    };
    const redirect = (to: string, status = 301) => {
      res.writeHead(status, { location: to });
      res.end();
    };

    if (host === EXT_HOST) {
      if (p === "/ok") return html("<title>ok</title>");
      if (p === "/forbidden") return html("Forbidden", 403);
      if (p === "/gone") return html("Gone", 410);
      if (p === "/no-head") {
        if (req.method === "HEAD") return html("", 405);
        return html("<title>GET only</title>");
      }
      if (p === "/to-private") return redirect("http://10.0.0.1/admin", 302);
      return html("nope", 404);
    }
    if (host !== SITE_HOST) return html("unknown host", 421);

    switch (p) {
      case "/robots.txt":
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end(`User-agent: *\nDisallow: /private/\n\nSitemap: ${origin}/sitemap.xml\n`);
      case "/sitemap.xml":
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/about</loc></url><url><loc>${origin}/orphan</loc></url></urlset>`);
      case "/":
        return html(page("index.html"));
      case "/about":
        return html(page("about.html"));
      case "/blog":
        return html(page("blog.html"));
      case "/orphan":
        return html(page("orphan.html"));
      case "/old-page":
        return redirect("/about", 301);
      case "/loop-a":
        return redirect("/loop-b", 302);
      case "/loop-b":
        return redirect("/loop-a", 302);
      case "/to-metadata":
        return redirect("http://169.254.169.254/latest/meta-data/", 302);
      case "/img/logo.png":
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(req.method === "HEAD" ? undefined : Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      case "/slow":
        setTimeout(() => html("<title>slow</title>"), 2000);
        return;
      case "/big":
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<html><title>big</title>" + "x".repeat(300_000));
      case "/private/secret":
        return html("<title>secret</title>");
      default:
        return html("<title>Not found</title><h1>404</h1>", 404);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    origin: `http://${SITE_HOST}:${port}`,
    extOrigin: `http://${EXT_HOST}:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Fake DNS: fixture hosts → 127.0.0.1; PRIVATE_HOST → 10.0.0.5; REBIND_HOST public first, then loopback. */
export function fixtureLookup(): LookupFn {
  let rebindCalls = 0;
  return (hostname, _opts, cb) => {
    const h = hostname.toLowerCase();
    if (h === SITE_HOST || h === EXT_HOST) return cb(null, [{ address: "127.0.0.1", family: 4 }]);
    if (h === PRIVATE_HOST) return cb(null, [{ address: "10.0.0.5", family: 4 }]);
    if (h === REBIND_HOST) {
      rebindCalls++;
      return cb(null, [{ address: rebindCalls === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }]);
    }
    const e: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    e.code = "ENOTFOUND";
    return cb(e, []);
  };
}

/** Test address policy: only the fixture server's loopback address counts as "public". */
export const fixturePolicy = (ip: string) => ip === "127.0.0.1";
