import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFn } from "@/lib/security/safe-fetch";

/**
 * A generated "public" website with many pages, for crawler scale tests.
 * Served on 127.0.0.1 under a public-looking hostname; tests route DNS for
 * that hostname only (bigSiteLookup) and allow only 127.0.0.1 (bigSitePolicy).
 *
 *  /                 links to /p/1 … /p/5, a redirect alias, a tracking-query
 *                    duplicate, a calendar trap, a robots-disallowed page, a
 *                    flaky page and an external site
 *  /p/N              links to /p/(5N+1 … 5N+5) while N ≤ pages (a 5-ary tree)
 *  /old              301 → /p/1 (redirect duplicate)
 *  /flaky            503 on the first request, 200 afterwards (transient error)
 *  /private/secret   disallowed by robots.txt
 *  /calendar?month=N infinite calendar (trap)
 */
export const BIG_HOST = "big.sitelens-fixture.com";
export const BIG_EXT_HOST = "elsewhere.sitelens-fixture.net";

export interface BigSite {
  port: number;
  origin: string;
  requests: Array<{ host: string; method: string; path: string }>;
  close(): Promise<void>;
}

export async function startBigSite(pages = 700): Promise<BigSite> {
  const requests: BigSite["requests"] = [];
  let flakyHits = 0;
  let port = 0;
  const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    const url = new URL(req.url ?? "/", "http://x");
    requests.push({ host, method: req.method ?? "GET", path: url.pathname + url.search });
    const origin = `http://${BIG_HOST}:${port}`;
    const html = (title: string, links: string[], status = 200) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      if (req.method === "HEAD") return res.end();
      res.end(
        `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="${title} page of the generated test site."><meta name="viewport" content="width=device-width"></head><body><h1>${title}</h1>${links.map((l) => `<a href="${l}">${l}</a>`).join(" ")}</body></html>`,
      );
    };
    if (host === BIG_EXT_HOST) return html("External", []);
    if (host !== BIG_HOST) {
      res.writeHead(421).end();
      return;
    }
    const p = url.pathname;
    if (p === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("User-agent: *\nDisallow: /private/\n");
    }
    if (p === "/sitemap.xml") {
      res.writeHead(404).end();
      return;
    }
    if (p === "/") {
      return html("Home", ["/p/1", "/p/2", "/p/3", "/p/4", "/p/5", "/old", "/p/1?utm_source=newsletter", "/calendar?month=1", "/private/secret", "/flaky", `http://${BIG_EXT_HOST}:${port}/`].map((l) => (l.startsWith("http") ? l : origin + l)));
    }
    if (p === "/old") {
      res.writeHead(301, { location: `${origin}/p/1` }).end();
      return;
    }
    if (p === "/flaky") {
      flakyHits++;
      if (flakyHits === 1) {
        res.writeHead(503, { "content-type": "text/html", "retry-after": "0" }).end("busy");
        return;
      }
      return html("Flaky", [`${origin}/`]);
    }
    if (p === "/calendar") {
      const m = Number(url.searchParams.get("month") ?? 1);
      return html(`Calendar ${m}`, [`${origin}/calendar?month=${m + 1}`]);
    }
    if (p === "/private/secret") return html("Secret", []);
    const m = /^\/p\/(\d+)$/.exec(p);
    if (m) {
      const n = Number(m[1]);
      if (n < 1 || n > pages) return html("Not found", [], 404);
      const kids = [1, 2, 3, 4, 5].map((k) => 5 * n + k).filter((k) => k <= pages);
      return html(`Page ${n}`, [`${origin}/`, ...kids.map((k) => `${origin}/p/${k}`)]);
    }
    return html("Not found", [], 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    origin: `http://${BIG_HOST}:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export function bigSiteLookup(): LookupFn {
  return (hostname, _opts, cb) => {
    const h = hostname.toLowerCase();
    if (h === BIG_HOST || h === BIG_EXT_HOST) return cb(null, [{ address: "127.0.0.1", family: 4 }]);
    const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return cb(err, []);
  };
}

export const bigSitePolicy = (ip: string) => ip === "127.0.0.1";
