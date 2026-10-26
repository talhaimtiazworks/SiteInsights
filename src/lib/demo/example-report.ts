import type { Severity } from "../audit/types";

/**
 * DEMONSTRATION DATA. This is a fixed, illustrative example used only on the
 * landing page to show what a report looks like. It is NOT the result of a
 * real scan and is always labelled as such in the UI.
 */
export const DEMO_REPORT = {
  label: "Demonstration data — not a real scan",
  site: "www.example-bakery.test",
  pagesScanned: 18,
  linksChecked: 142,
  scores: [
    { label: "Links", score: 79 },
    { label: "On-page SEO", score: 72 },
    { label: "Crawling & indexing", score: 88 },
    { label: "Accessibility", score: 90 },
    { label: "HTTPS & security", score: 100 },
  ],
  severityCounts: { critical: 0, high: 2, medium: 4, low: 5, info: 3 } as Record<Severity, number>,
  findings: [
    { severity: "high" as Severity, title: "Broken internal link (HTTP 404)", detail: "/menu/seasonal-cakes linked from 3 pages", type: "Error" },
    { severity: "high" as Severity, title: "Missing page title", detail: "/order/thank-you", type: "Error" },
    { severity: "medium" as Severity, title: "Missing meta description", detail: "6 of 18 pages", type: "Recommendation" },
    { severity: "medium" as Severity, title: "Images without alt attribute", detail: "11 images on 4 pages", type: "Error" },
    { severity: "low" as Severity, title: "Internal links point to redirecting URLs", detail: "9 links via http:// → https://", type: "Recommendation" },
    { severity: "info" as Severity, title: "Links that could not be verified", detail: "2 external sites blocked automated requests (HTTP 403)", type: "Observation" },
  ],
  ai: {
    title: "Broken internal link (HTTP 404)",
    plain: "Three pages link to /menu/seasonal-cakes, but that address returns “Not Found”. Visitors who click the link see an error page instead of the seasonal menu.",
    fix: "Point the links to the current seasonal menu URL, or add a permanent 301 redirect from /menu/seasonal-cakes to it.",
    code: "# nginx\nlocation = /menu/seasonal-cakes {\n  return 301 /menu/seasonal;\n}",
  },
};
