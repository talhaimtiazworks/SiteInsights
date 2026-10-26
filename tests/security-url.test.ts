import { describe, expect, it } from "vitest";
import { normalizeUrl, resolveHref, sameSiteHost, validatePublicUrl, validateRedirectTarget } from "@/lib/security/url";
import { parseHttpUrlInput } from "@/lib/security/url-input";

describe("validatePublicUrl", () => {
  it("accepts public http(s) URLs and adds https:// when the scheme is missing", () => {
    const a = validatePublicUrl("https://example.com/path?q=1");
    expect(a.ok).toBe(true);
    const b = validatePublicUrl("example.com");
    expect(b.ok && b.url.protocol).toBe("https:");
  });

  it.each([
    ["http://localhost/", "localhost"],
    ["http://foo.localhost/", "localhost subdomain"],
    ["http://127.0.0.1/", "loopback"],
    ["http://10.1.2.3/", "private 10/8"],
    ["http://192.168.0.10:8080/", "private 192.168/16"],
    ["http://169.254.169.254/latest/meta-data/", "metadata IP"],
    ["http://metadata.google.internal/", "metadata hostname"],
    ["http://[::1]/", "IPv6 loopback"],
    ["http://[::ffff:127.0.0.1]/", "IPv4-mapped IPv6"],
    ["http://2130706433/", "decimal-encoded loopback"],
    ["http://0x7f000001/", "hex-encoded loopback"],
    ["http://0177.0.0.1/", "octal-encoded loopback"],
    ["http://0/", "zero address"],
    ["http://intranet/", "single-label host"],
    ["http://printer.local/", ".local"],
    ["http://router.internal/", ".internal"],
    ["ftp://example.com/", "non-http scheme"],
    ["file:///etc/passwd", "file scheme"],
    ["javascript:alert(1)", "javascript scheme"],
    ["http://user:pass@example.com/", "embedded credentials"],
    ["http://example.com:22/", "disallowed port"],
  ])("rejects %s (%s)", (raw) => {
    expect(validatePublicUrl(raw).ok).toBe(false);
  });

  it("rejects overly long URLs", () => {
    expect(validatePublicUrl(`https://example.com/${"a".repeat(3000)}`).ok).toBe(false);
  });

  it("allows only configured ports", () => {
    expect(validatePublicUrl("http://example.com:9000/").ok).toBe(false);
    expect(validatePublicUrl("http://example.com:9000/", { allowedPorts: [80, 443, 9000] }).ok).toBe(true);
    expect(validatePublicUrl("https://example.com/", { allowedPorts: [80] }).ok).toBe(false);
  });
});

describe("parseHttpUrlInput (shared form/server syntax and normalization)", () => {
  it("normalizes bare domains and equivalent public URLs exactly as the server does", () => {
    const raw = "Example.COM/path?z=2&a=1&utm_source=mail#section";
    const client = parseHttpUrlInput(raw);
    const server = validatePublicUrl(raw);
    expect(client.ok && client.normalized).toBe("https://example.com/path?a=1&z=2");
    expect(server.ok && server.normalized).toBe(client.ok ? client.normalized : null);
    const protocolRelative = parseHttpUrlInput("//example.com");
    expect(protocolRelative.ok && protocolRelative.normalized).toBe("https://example.com/");
  });

  it.each([
    ["", "empty"],
    ["ftp://example.com", "unsupported_scheme"],
    ["javascript:alert(1)", "unsupported_scheme"],
    ["https://user:pass@example.com", "credentials_not_allowed"],
    ["https://exa mple.com", "malformed"],
    ["https://example.com/" + "x".repeat(2050), "too_long"],
  ])("rejects invalid input %j", (raw, reason) => {
    const result = parseHttpUrlInput(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it("leaves public-host and IP safety decisions to authoritative server validation", () => {
    expect(parseHttpUrlInput("http://127.0.0.1/").ok).toBe(true);
    expect(validatePublicUrl("http://127.0.0.1/")).toMatchObject({ ok: false, reason: "private_address" });
  });
});

describe("validateRedirectTarget", () => {
  it("resolves relative redirects against the current URL", () => {
    const r = validateRedirectTarget("https://example.com/a/b", "../c");
    expect(r.ok && r.url.href).toBe("https://example.com/c");
  });
  it.each(["http://127.0.0.1/admin", "http://169.254.169.254/", "http://localhost:3000/", "file:///etc/passwd", "http://[fd00::1]/"])("blocks redirects to %s", (loc) => {
    expect(validateRedirectTarget("https://example.com/", loc).ok).toBe(false);
  });
  it("allows redirects to other public hosts", () => {
    expect(validateRedirectTarget("http://example.com/", "https://www.example.org/").ok).toBe(true);
  });
});

describe("normalizeUrl (deduplication)", () => {
  it("normalises equivalent URLs to the same key", () => {
    const variants = [
      "https://Example.COM/Path?b=2&a=1#section",
      "https://example.com:443/Path?a=1&b=2",
      "https://example.com/Path?a=1&b=2&utm_source=newsletter&fbclid=abc",
    ];
    const set = new Set(variants.map((v) => normalizeUrl(v)));
    expect(set.size).toBe(1);
    expect([...set][0]).toBe("https://example.com/Path?a=1&b=2");
  });
  it("keeps path case and distinguishes different paths", () => {
    expect(normalizeUrl("https://example.com/A")).not.toBe(normalizeUrl("https://example.com/a"));
  });
  it("removes default http port and trailing ? but keeps root slash", () => {
    expect(normalizeUrl("http://example.com:80?")).toBe("http://example.com/");
  });
});

describe("resolveHref", () => {
  it("resolves relative links and ignores non-http schemes", () => {
    expect(resolveHref("/x", "https://example.com/a/")).toEqual({ kind: "http", url: "https://example.com/x" });
    expect(resolveHref("mailto:a@b.c", "https://example.com/").kind).toBe("ignored");
    expect(resolveHref("tel:123", "https://example.com/").kind).toBe("ignored");
    expect(resolveHref("javascript:void(0)", "https://example.com/").kind).toBe("ignored");
    expect(resolveHref("#top", "https://example.com/").kind).toBe("ignored");
  });
  it("flags malformed links as invalid", () => {
    expect(resolveHref("http://exa mple.com/", "https://example.com/").kind).toBe("invalid");
  });
});

describe("sameSiteHost", () => {
  it("treats www and apex as the same site but not other subdomains", () => {
    expect(sameSiteHost("www.example.com", "example.com")).toBe(true);
    expect(sameSiteHost("example.com", "www.example.com")).toBe(true);
    expect(sameSiteHost("blog.example.com", "example.com")).toBe(false);
    expect(sameSiteHost("example.com.evil.com", "example.com")).toBe(false);
  });
});
