import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePublicHost, safeFetch, type SafeFetchOptions } from "@/lib/security/safe-fetch";
import { fixtureLookup, fixturePolicy, PRIVATE_HOST, REBIND_HOST, MISSING_HOST, startFixtureServer, type FixtureServer } from "./helpers/fixture-server";

let srv: FixtureServer;
let base: SafeFetchOptions;

beforeAll(async () => {
  srv = await startFixtureServer();
  base = { timeoutMs: 1000, maxBodyBytes: 100_000, maxRedirects: 5, userAgent: "SiteLensAI-test", allowedPorts: [srv.port, 80, 443], addressPolicy: fixturePolicy, lookup: fixtureLookup() };
});
afterAll(() => srv.close());

describe("resolvePublicHost", () => {
  it("rejects hosts that resolve to private addresses", async () => {
    const r = await resolvePublicHost(PRIVATE_HOST, fixtureLookup());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsafe_destination");
  });
  it("reports DNS failures", async () => {
    const r = await resolvePublicHost(MISSING_HOST, fixtureLookup());
    expect(r.ok === false && r.code).toBe("dns_error");
  });
  it("rejects mixed public/private answers (rebinding signal)", async () => {
    const lookup: typeof base.lookup = (_h, _o, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    const r = await resolvePublicHost("mixed.example.org", lookup);
    expect(r.ok).toBe(false);
  });
});

describe("safeFetch", () => {
  it("fetches a page and records status, body and timing", async () => {
    const r = await safeFetch(`${srv.origin}/`, base);
    expect(r.error).toBeNull();
    expect(r.status).toBe(200);
    expect(r.body?.toString()).toContain("Fixture Bakery");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("blocks connections when the address policy rejects the resolved IP (default public-only policy)", async () => {
    const { addressPolicy: _drop, ...noPolicy } = base;
    void _drop;
    const r = await safeFetch(`${srv.origin}/`, noPolicy);
    expect(r.error?.code).toBe("unsafe_destination");
    expect(r.status).toBeNull();
  });

  it("blocks DNS rebinding: host validated as public but resolving to loopback at connect time", async () => {
    const lookup = fixtureLookup();
    const pre = await resolvePublicHost(REBIND_HOST, lookup);
    expect(pre.ok).toBe(true); // first answer is public
    const { addressPolicy: _drop, ...noPolicy } = base;
    void _drop;
    const r = await safeFetch(`http://${REBIND_HOST}:${srv.port}/`, { ...noPolicy, lookup });
    expect(r.error?.code).toBe("unsafe_destination");
  });

  it("revalidates redirects and refuses redirects to metadata/private IPs", async () => {
    const r = await safeFetch(`${srv.origin}/to-metadata`, base);
    expect(r.error?.code).toBe("unsafe_destination");
    expect(srv.requests.some((q) => q.path.includes("meta-data"))).toBe(false);
    const r2 = await safeFetch(`${srv.extOrigin}/to-private`, base);
    expect(r2.error?.code).toBe("unsafe_destination");
  });

  it("follows safe redirects and records the chain", async () => {
    const r = await safeFetch(`${srv.origin}/old-page`, base);
    expect(r.status).toBe(200);
    expect(r.redirectChain).toEqual([{ url: `${srv.origin}/old-page`, status: 301 }]);
    expect(r.finalUrl).toBe(`${srv.origin}/about`);
  });

  it("detects redirect loops", async () => {
    const r = await safeFetch(`${srv.origin}/loop-a`, base);
    expect(r.error?.code).toBe("redirect_loop");
  });

  it("enforces the redirect limit", async () => {
    const r = await safeFetch(`${srv.origin}/old-page`, { ...base, maxRedirects: 0 });
    expect(r.error?.code).toBe("too_many_redirects");
  });

  it("times out slow responses", async () => {
    const r = await safeFetch(`${srv.origin}/slow`, { ...base, timeoutMs: 300 });
    expect(r.error?.code).toBe("timeout");
  });

  it("truncates bodies at maxBodyBytes", async () => {
    const r = await safeFetch(`${srv.origin}/big`, { ...base, maxBodyBytes: 10_000 });
    expect(r.bodyTruncated).toBe(true);
    expect(r.body!.length).toBeLessThanOrEqual(10_000);
  });

  it("rejects disallowed ports before connecting", async () => {
    const before = srv.requests.length;
    const r = await safeFetch(`${srv.origin}/`, { ...base, allowedPorts: [80, 443] });
    expect(r.error?.code).toBe("unsafe_destination");
    expect(r.status).toBeNull();
    expect(srv.requests.length).toBe(before);
  });

  it("reports DNS errors", async () => {
    const r = await safeFetch(`http://${MISSING_HOST}/`, base);
    expect(r.error?.code).toBe("dns_error");
  });
});
