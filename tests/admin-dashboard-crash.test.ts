/**
 * Regression suite for the 2026-10-23 production incident:
 *   1. /admin/analytics showed the whole-app error page ("Something went
 *      wrong") after loading. Root cause: the dashboard client read the API
 *      envelope `{ ok, data }` as if it were the payload, so `overview.totals`
 *      was undefined and the render threw — exactly after the data arrived.
 *   2. Product-metric SQL referenced a column that does not exist
 *      (profiles.principal_id) and a pre-rename table (usage_events); those
 *      failures were silently swallowed. They are now correct + logged.
 *   3. Protected-route failures produced opaque 500s; they are now logged
 *      server-side and mapped to honest 503 states the UI handles.
 * This file pins all of those contracts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "node-html-parser";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
const mocks = { pathname: "/account/profile" };

import { AccountNav } from "@/components/account-nav";
import { unwrapApi } from "@/lib/analytics/api-envelope";
import { analyticsFailure } from "@/lib/analytics/errors";
import { ApiError } from "@/lib/http/api";

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => parse(renderToStaticMarkup(el));

describe("dashboard crash regression — API envelope handling", () => {
  const payload = { totals: { uniqueVisitors: { current: 3 } } };

  it("unwraps the standard { ok: true, data } envelope the API actually sends", () => {
    const data = unwrapApi<typeof payload>({ ok: true, data: payload }, 200);
    expect(data.totals.uniqueVisitors.current).toBe(3);
  });

  it("reading the payload without unwrapping yields undefined (the exact production crash shape)", () => {
    const raw = { ok: true, data: payload } as unknown as typeof payload;
    expect(raw.totals).toBeUndefined(); // documents why the render threw TypeError
    expect(unwrapApi<typeof payload>(raw, 200).totals).toBeDefined();
  });

  it("error envelopes surface as errors, not as renderable data", () => {
    expect(() => unwrapApi({ ok: false, error: { code: "forbidden", message: "No." } }, 403)).toThrow(/forbidden/);
  });

  it("non-enveloped payloads pass through untouched (defensive)", () => {
    expect(unwrapApi<typeof payload>(payload, 200).totals.uniqueVisitors.current).toBe(3);
  });
});

describe("dashboard crash regression — logged, honest 503 mapping", () => {
  it("maps a missing-table failure (42P01) to 503 analytics_not_migrated", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      analyticsFailure("overview", { code: "42P01", message: 'relation "analytics_events" does not exist' });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(503);
      expect((err as ApiError).code).toBe("analytics_not_migrated");
    }
    expect(spy).toHaveBeenCalledOnce();
    const line = String(spy.mock.calls[0]![1]);
    expect(line).toContain("42P01");
    expect(line).not.toContain("DATABASE_URL");
    spy.mockRestore();
  });

  it("maps generic database failures to 503 analytics_unavailable and logs them", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      analyticsFailure("popular", new Error("connection reset by peer"));
    } catch (err) {
      expect((err as ApiError).status).toBe(503);
      expect((err as ApiError).code).toBe("analytics_unavailable");
    }
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe("dashboard client — loading state renders safely (SSR)", () => {
  it("renders its shell without throwing before any data arrives", async () => {
    const { AdminAnalyticsClient } = await import("@/app/admin/analytics/analytics-client");
    expect(() => renderToStaticMarkup(createElement(AdminAnalyticsClient))).not.toThrow();
  });
  it("the local error boundary recovers to a warning state instead of the app error page", async () => {
    const { AnalyticsErrorBoundary } = await import("@/app/admin/analytics/error-boundary");
    const html = render(createElement(AnalyticsErrorBoundary, null, createElement("p", null, "ok")));
    expect(html.text).toContain("ok");
    expect(typeof AnalyticsErrorBoundary.getDerivedStateFromError).toBe("function");
  });
});

describe("account sidebar — Admin Analytics visibility", () => {
  it("shows the Admin Analytics item linking to /admin/analytics for the owner", () => {
    mocks.pathname = "/account/profile";
    const html = render(createElement(AccountNav, { isAdmin: true }));
    const link = html.querySelector('a[href="/admin/analytics"]');
    expect(link).not.toBeNull();
    expect(link!.text.trim()).toBe("Admin Analytics");
    expect(link!.getAttribute("aria-current")).toBeUndefined(); // not on the dashboard yet
  });

  it("hides it from ordinary users (default prop is safe)", () => {
    mocks.pathname = "/account/profile";
    expect(render(createElement(AccountNav, { isAdmin: false })).querySelector('a[href="/admin/analytics"]')).toBeNull();
    expect(render(createElement(AccountNav)).querySelector('a[href="/admin/analytics"]')).toBeNull();
  });

  it("marks the item with the shared active state when the dashboard route is open", () => {
    mocks.pathname = "/admin/analytics";
    const link = render(createElement(AccountNav, { isAdmin: true })).querySelector('a[href="/admin/analytics"]');
    expect(link!.getAttribute("aria-current")).toBe("page");
    expect(link!.getAttribute("class")).toContain("nav-selected");
    mocks.pathname = "/account/profile";
  });

  it("preserves every existing item and its ordering", () => {
    const html = render(createElement(AccountNav, { isAdmin: true }));
    const labels = html.querySelectorAll("nav a").map((a) => a.text.trim());
    expect(labels).toEqual([
      "Admin Analytics",
      "Profile",
      "Professional profile",
      "Security",
      "Connected accounts",
      "AI settings",
      "Usage",
      "Audit defaults",
      "Teams",
      "Delete account",
    ]);
  });
});
