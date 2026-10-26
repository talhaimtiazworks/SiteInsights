import { describe, expect, it } from "vitest";
import { isDevelopmentHost, resolveAppUrl } from "@/lib/config/app-url";

const prod = { NODE_ENV: "production" };
const vercelProd = { ...prod, VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "sitelens-ai.vercel.app" };

describe("resolveAppUrl", () => {
  it("uses an explicit NEXT_PUBLIC_APP_URL (origin only)", () => {
    const r = resolveAppUrl({ ...vercelProd, NEXT_PUBLIC_APP_URL: "https://sitelens-ai.vercel.app/" });
    expect(r).toMatchObject({ appUrl: "https://sitelens-ai.vercel.app", source: "NEXT_PUBLIC_APP_URL" });
    expect(r.issues).toEqual([]);
  });

  it("never uses localhost on a Vercel deployment — falls back to the production domain and reports an error", () => {
    for (const bad of ["http://localhost:3000", "http://127.0.0.1:3000", "http://0.0.0.0:3000", "http://[::1]:3000", "http://mybox.local"]) {
      const r = resolveAppUrl({ ...vercelProd, NEXT_PUBLIC_APP_URL: bad });
      expect(r.appUrl, bad).toBe("https://sitelens-ai.vercel.app");
      expect(r.source).toBe("VERCEL_PROJECT_PRODUCTION_URL");
      expect(r.issues.some((i) => i.severity === "error" && i.variables.includes("NEXT_PUBLIC_APP_URL"))).toBe(true);
    }
  });

  it("on a Vercel preview, a localhost value is ignored and the request origin is used", () => {
    const r = resolveAppUrl({ ...prod, VERCEL: "1", VERCEL_ENV: "preview", NEXT_PUBLIC_APP_URL: "http://localhost:3000" });
    expect(r.appUrl).toBeNull();
    expect(r.issues[0].severity).toBe("error");
  });

  it("falls back to VERCEL_PROJECT_PRODUCTION_URL in Vercel production when unset (with a warning)", () => {
    const r = resolveAppUrl(vercelProd);
    expect(r).toMatchObject({ appUrl: "https://sitelens-ai.vercel.app", source: "VERCEL_PROJECT_PRODUCTION_URL" });
    expect(r.issues.map((i) => i.severity)).toEqual(["warning"]);
  });

  it("does not use the production domain on preview deployments", () => {
    expect(resolveAppUrl({ ...vercelProd, VERCEL_ENV: "preview" }).appUrl).toBeNull();
  });

  it("allows localhost in development and (with a warning) in self-hosted production test runs", () => {
    expect(resolveAppUrl({ NODE_ENV: "development", NEXT_PUBLIC_APP_URL: "http://localhost:3000" })).toMatchObject({ appUrl: "http://localhost:3000", issues: [] });
    const r = resolveAppUrl({ ...prod, NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000" });
    expect(r.appUrl).toBe("http://127.0.0.1:3000");
    expect(r.issues.map((i) => i.severity)).toEqual(["warning"]);
  });

  it("rejects invalid values and warns about paths and http in production", () => {
    expect(resolveAppUrl({ ...prod, NEXT_PUBLIC_APP_URL: "sitelens-ai.vercel.app" }).issues[0].severity).toBe("error");
    expect(resolveAppUrl({ ...prod, NEXT_PUBLIC_APP_URL: "javascript:alert(1)" }).appUrl).toBeNull();
    const r = resolveAppUrl({ ...prod, NEXT_PUBLIC_APP_URL: "https://example.com/app?x=1" });
    expect(r.appUrl).toBe("https://example.com");
    expect(r.issues.some((i) => /path or query/.test(i.problem))).toBe(true);
    expect(resolveAppUrl({ ...prod, NEXT_PUBLIC_APP_URL: "http://example.com" }).issues.some((i) => /http:\/\//.test(i.problem))).toBe(true);
  });

  it("issue texts never echo the configured value", () => {
    const r = resolveAppUrl({ ...vercelProd, NEXT_PUBLIC_APP_URL: "http://localhost:31337" });
    expect(JSON.stringify(r.issues)).not.toContain("31337");
  });
});

describe("isDevelopmentHost", () => {
  it("classifies hosts", () => {
    for (const h of ["localhost", "127.0.0.1", "127.1.2.3", "0.0.0.0", "[::1]", "box.local", "app.localhost"]) expect(isDevelopmentHost(h), h).toBe(true);
    for (const h of ["sitelens-ai.vercel.app", "example.com", "127.example.com", "local.example.com"]) expect(isDevelopmentHost(h), h).toBe(false);
  });
});
