import type { AxeViolation, RenderResult } from "../browser/protocol";
import { BROKEN_CATEGORIES, type LinkCheckRecord, type PageRecord } from "../scanner/types";
import type { MakeFn } from "./analyze";
import type { Finding, Severity } from "./types";

/**
 * Findings from the browser worker: rendering problems, JavaScript-only
 * content, mobile layout checks and axe-core accessibility results.
 * Deterministic: the same render results always produce the same findings.
 */

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const noindex = (v: string | null | undefined) => /\b(noindex|none)\b/i.test(v ?? "");

export const AXE_IMPACT_SEVERITY: Record<NonNullable<AxeViolation["impact"]>, Severity> = { critical: "high", serious: "medium", moderate: "low", minor: "info" };

/** axe rules that duplicate an HTML-based rule that already covers every crawled page. */
const AXE_STATIC_EQUIVALENT: Record<string, string> = {
  "image-alt": "accessibility.img_alt_missing",
  "html-has-lang": "accessibility.lang_missing",
  "html-lang-valid": "accessibility.lang_invalid",
  "document-title": "seo.title_missing",
};

/** "wcag111" → "1.1.1", "wcag2411" → "2.4.11"; level tags → "WCAG 2.1 AA". */
export function describeWcagTags(tags: string[]): { criteria: string[]; levels: string[]; bestPractice: boolean } {
  const criteria: string[] = [];
  const levels: string[] = [];
  for (const t of tags) {
    const lvl = /^wcag(2|21|22)(a|aa|aaa)$/.exec(t);
    if (lvl) {
      levels.push(`WCAG ${lvl[1] === "2" ? "2.0" : `2.${lvl[1][1]}`} ${lvl[2].toUpperCase()}`);
      continue;
    }
    const sc = /^wcag(\d)(\d)(\d{1,2})$/.exec(t);
    if (sc) criteria.push(`${sc[1]}.${sc[2]}.${sc[3]}`);
  }
  return { criteria: [...new Set(criteria)], levels: [...new Set(levels)], bestPractice: tags.includes("best-practice") && criteria.length === 0 };
}

export function analyzeBrowser(input: { make: MakeFn; renders: Array<{ url: string; result: RenderResult }>; pageByUrl: Map<string, PageRecord>; links: LinkCheckRecord[]; staticFindings: Finding[] }) {
  const { make, renders, pageByUrl } = input;
  type Hit = { url: string; detail: string };
  const groups: Record<string, Hit[]> = {};
  const hit = (rule: string, url: string, detail: string) => (groups[rule] ??= []).push({ url, detail });
  let jsSeverity: Severity = "low";
  let reqSeverity: Severity = "low";
  let metaSeverity: Severity = "low";
  const staticallyCheckedImages = new Set(input.links.filter((l) => l.kind === "image").map((l) => l.url));
  const brokenStatic = new Set(input.links.filter((l) => BROKEN_CATEGORIES.includes(l.category)).map((l) => l.url));
  const ok = renders.filter((r) => r.result.ok);

  for (const { url, result: r } of renders) {
    if (!r.ok) {
      hit("browser.render_failed", url, r.error ? `${r.error.code.replace(/_/g, " ")}: ${r.error.message}` : "Rendering failed");
      continue;
    }
    const page = pageByUrl.get(url);

    // JavaScript errors
    const errs = r.console.filter((c) => c.kind === "pageerror" || c.kind === "error");
    if (errs.length) {
      if (errs.some((e) => e.kind === "pageerror")) jsSeverity = "medium";
      const extra = r.consoleTotal > r.console.length ? ` (+${r.consoleTotal - r.console.length} more)` : "";
      hit("browser.js_errors", url, errs.slice(0, 4).map((e) => `${e.kind === "pageerror" ? "Uncaught" : "console.error"}: ${e.text.slice(0, 160)}`).join(" | ") + extra);
    }

    // Failed subresources (ignoring requests we blocked and benign aborts)
    const failed = r.failedRequests.filter((f) => !f.blockedBySafety && !(f.status === null && /ERR_ABORTED/i.test(f.failure ?? "")) && !brokenStatic.has(f.url));
    if (failed.length) {
      if (failed.some((f) => ["script", "stylesheet", "document"].includes(f.resourceType))) reqSeverity = "medium";
      hit("browser.failed_requests", url, failed.slice(0, 5).map((f) => `${f.resourceType} ${f.url.slice(0, 160)} → ${f.status !== null ? `HTTP ${f.status}` : f.failure ?? "failed"}`).join(" | "));
    }
    const blocked = r.failedRequests.filter((f) => f.blockedBySafety);
    if (blocked.length && groups["browser.failed_requests"]?.at(-1)?.url === url) {
      groups["browser.failed_requests"].at(-1)!.detail += ` | ${r.blockedRequestCount} request(s) were not made for safety (private network or disallowed port).`;
    }

    // Broken images that are not in the raw HTML
    const staticSrcs = new Set((page?.images ?? []).map((i) => i.src).filter(Boolean) as string[]);
    const brokenImgs = r.images.filter((i) => i.broken && !staticSrcs.has(i.src) && !staticallyCheckedImages.has(i.src));
    if (brokenImgs.length) hit("browser.broken_images", url, `${brokenImgs.length} image(s): ${brokenImgs.slice(0, 4).map((i) => i.src.slice(0, 160)).join(", ")}`);

    if (page && r.dom) {
      // Content that only exists after JavaScript
      const staticWords = page.wordCount ?? null;
      if (staticWords !== null && r.dom.wordCount >= 150 && staticWords < r.dom.wordCount * 0.3) {
        hit("browser.js_only_content", url, `${staticWords} words in the HTML vs ${r.dom.wordCount} after rendering`);
      }
      // Internal links only in the rendered DOM
      const staticLinks = new Set(page.links.map((l) => l.url));
      const jsLinks = r.links.filter((l) => l.internal && !staticLinks.has(l.url));
      const staticInternal = page.links.filter((l) => l.internal).length;
      if (jsLinks.length >= 5 || (jsLinks.length > 0 && staticInternal === 0)) {
        hit("browser.js_only_links", url, `${jsLinks.length} internal link(s) only after JavaScript (HTML has ${staticInternal}), e.g. ${jsLinks.slice(0, 3).map((l) => l.url).join(", ")}`);
      }
      // Metadata changed by JavaScript
      const changes: string[] = [];
      if (noindex(page.robotsMeta) !== noindex(r.dom.robotsMeta)) {
        changes.push(`robots: HTML “${page.robotsMeta ?? "none"}” → rendered “${r.dom.robotsMeta ?? "none"}”`);
        metaSeverity = "high";
      }
      if ((page.canonical ?? null) !== (r.dom.canonical ?? null)) {
        changes.push(`canonical: HTML ${page.canonical ?? "none"} → rendered ${r.dom.canonical ?? "none"}`);
        if (metaSeverity !== "high") metaSeverity = "medium";
      }
      if (norm(page.title) !== norm(r.dom.title)) changes.push(`title: HTML “${(page.title ?? "none").slice(0, 80)}” → rendered “${(r.dom.title ?? "none").slice(0, 80)}”`);
      if (norm(page.metaDescription) !== norm(r.dom.metaDescription)) changes.push(page.metaDescription ? "meta description differs after rendering" : "meta description is only set by JavaScript");
      if (changes.length) hit("browser.metadata_changed", url, changes.join(" | "));
    }

    // Mobile layout (390 px viewport)
    const m = r.mobile;
    if (m) {
      if (m.horizontalOverflow) hit("browser.mobile_overflow", url, `Content is ${m.scrollWidth}px wide in a ${m.viewportWidth}px viewport${m.overflowing.length ? `; widest: ${m.overflowing.slice(0, 3).map((o) => `${o.selector} (right edge ${Math.round(o.right)}px)`).join(", ")}` : ""}`);
      if (!r.axe && m.smallTapTargetsTotal >= 3) hit("browser.mobile_tap_targets", url, `${m.smallTapTargetsTotal} of ${m.tapTargetsChecked} controls under 24×24px, e.g. ${m.smallTapTargets.slice(0, 3).map((t) => `${t.selector} (${Math.round(t.width)}×${Math.round(t.height)})`).join(", ")}`);
      if (m.textNodesChecked >= 10 && m.smallTextTotal >= 5 && m.smallTextTotal / m.textNodesChecked > 0.2) hit("browser.mobile_small_text", url, `${m.smallTextTotal} of ${m.textNodesChecked} text elements under 12px, e.g. ${m.smallText.slice(0, 3).map((t) => `${t.selector} (${t.fontSize}px)`).join(", ")}`);
    }
  }

  const severityFor: Record<string, Severity | undefined> = { "browser.js_errors": jsSeverity, "browser.failed_requests": reqSeverity, "browser.metadata_changed": metaSeverity };
  for (const [rule, hits] of Object.entries(groups)) {
    make(rule as Parameters<MakeFn>[0], rule, {
      affectedUrls: hits.map((h) => h.url),
      severity: severityFor[rule],
      ctx: { count: hits.length },
      evidence: {
        summary: `Detected on ${hits.length} of ${renders.length} page${renders.length === 1 ? "" : "s"} rendered in Chromium (390×844 mobile viewport).`,
        items: hits.map((h) => ({ label: h.url, value: h.detail })),
      },
    });
  }

  // ---- axe-core ----------------------------------------------------------------
  const tested = ok.filter((r) => r.result.axe);
  if (!tested.length) return;
  const byRule = new Map<string, { v: AxeViolation; pages: Array<{ url: string; v: AxeViolation }> }>();
  for (const { url, result } of tested) {
    for (const v of result.axe!.violations) {
      const cur = byRule.get(v.id) ?? { v, pages: [] };
      cur.pages.push({ url, v });
      byRule.set(v.id, cur);
    }
  }
  const order: Array<NonNullable<AxeViolation["impact"]>> = ["critical", "serious", "moderate", "minor"];
  for (const [id, { v, pages }] of byRule) {
    const equivalent = AXE_STATIC_EQUIVALENT[id];
    if (equivalent) {
      const st = input.staticFindings.find((f) => f.ruleId === equivalent);
      if (st && pages.every((p) => st.affectedUrls.includes(p.url))) continue;
    }
    const impact = pages.map((p) => p.v.impact).filter((x): x is NonNullable<AxeViolation["impact"]> => !!x).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? null;
    const severity: Severity = impact ? AXE_IMPACT_SEVERITY[impact] : "low";
    const wcag = describeWcagTags(v.tags);
    const totalNodes = pages.reduce((a, p) => a + p.v.nodeCount, 0);
    const items: Array<{ label: string; value: string }> = [
      { label: "axe rule", value: id },
      { label: "Impact", value: impact ?? "not specified" },
      { label: "WCAG", value: wcag.bestPractice ? "Best practice (not a WCAG requirement)" : [wcag.criteria.length ? `Success criterion ${wcag.criteria.join(", ")}` : null, wcag.levels.join(", ") || null].filter(Boolean).join(" · ") || "—" },
      { label: "Guidance", value: v.helpUrl },
    ];
    for (const p of pages) {
      for (const n of p.v.nodes.slice(0, 4)) {
        if (items.length >= 38) break;
        items.push({ label: `${p.url} — ${n.target.join(" ")}`.slice(0, 120), value: `${n.html}${n.failureSummary ? `\n${n.failureSummary}` : ""}` });
      }
    }
    make("accessibility.axe", `axe:${id}`, {
      ruleIdOverride: `accessibility.axe.${id}`.slice(0, 80),
      title: v.help.slice(0, 200),
      description: `${v.description} Detected by automated testing; automated tools find only some accessibility problems, and this does not establish WCAG conformance or legal compliance.`.slice(0, 2000),
      severity,
      rule: {
        type: wcag.bestPractice || severity === "info" ? "recommendation" : "error",
        detectionMethod: `axe-core ${tested[0].result.axe!.version} in headless Chromium (390×844 mobile viewport), rule “${id}”.`,
        recommendation: `${v.help}. See ${v.helpUrl} for how to fix it, then re-test.`.slice(0, 2000),
      },
      affectedUrls: pages.map((p) => p.url),
      evidence: { summary: `${totalNodes} element(s) on ${pages.length} of ${tested.length} tested page${tested.length === 1 ? "" : "s"} failed “${v.help}”.`, items },
    });
  }
}
