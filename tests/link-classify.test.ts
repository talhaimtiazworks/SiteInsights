import { describe, expect, it } from "vitest";
import { classifyFetchResult } from "@/lib/scanner/link-classify";
import { BROKEN_CATEGORIES, INCONCLUSIVE_CATEGORIES } from "@/lib/scanner/types";

const res = (status: number | null, error: { code: string; message: string } | null = null, redirects = 0) =>
  classifyFetchResult({ status, error: error as never, redirectChain: Array.from({ length: redirects }, (_, i) => ({ url: `https://e.com/${i}`, status: 301 })) });

describe("classifyFetchResult", () => {
  it("classifies OK and redirected links", () => {
    expect(res(200).category).toBe("ok");
    expect(res(200, null, 2).category).toBe("redirect");
  });

  it("classifies 404 and 410 as confirmed broken (not_found)", () => {
    for (const s of [404, 410]) {
      const c = res(s);
      expect(c.category).toBe("not_found");
      expect(c.verification).toBe("verified");
      expect(BROKEN_CATEGORIES).toContain(c.category);
    }
  });

  it.each([401, 403, 407, 429, 451, 999])("never reports HTTP %i (auth/blocked) as broken", (s) => {
    const c = res(s);
    expect(c.category).toBe("blocked");
    expect(c.verification).toBe("inconclusive");
    expect(BROKEN_CATEGORIES).not.toContain(c.category);
  });

  it("treats other 4xx as inconclusive client errors", () => {
    const c = res(400);
    expect(c.category).toBe("client_error");
    expect(INCONCLUSIVE_CATEGORIES).toContain(c.category);
  });

  it("classifies 5xx as server errors", () => {
    expect(res(500).category).toBe("server_error");
    expect(res(503).category).toBe("server_error");
  });

  it.each([
    ["dns_error", "dns_error", "verified"],
    ["dns_temporary", "inconclusive", "inconclusive"],
    ["connection_error", "connection_error", "inconclusive"],
    ["timeout", "timeout", "inconclusive"],
    ["redirect_loop", "redirect_loop", "verified"],
    ["too_many_redirects", "too_many_redirects", "verified"],
    ["invalid_url", "invalid_url", "verified"],
    ["tls_error", "tls_error", "verified"],
    ["unsafe_destination", "unsafe_destination", "not_checked"],
  ])("maps fetch error %s → %s (%s)", (code, category, verification) => {
    const c = res(null, { code, message: "x" });
    expect(c.category).toBe(category);
    expect(c.verification).toBe(verification);
  });

  it("does not count timeouts or connection errors as broken", () => {
    expect(BROKEN_CATEGORIES).not.toContain(res(null, { code: "timeout", message: "" }).category);
    expect(BROKEN_CATEGORIES).not.toContain(res(null, { code: "connection_error", message: "" }).category);
  });
});
