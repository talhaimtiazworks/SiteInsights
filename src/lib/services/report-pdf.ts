import "server-only";
import type { RenderResult } from "../browser/protocol";
import type { Finding } from "../audit/types";
import type { RenderSummary } from "./views";

import type { Repository } from "../db/types";
import { getAccountRepository } from "../db";
import type { ClientReportSnapshot } from "../report/snapshot-types";
import { buildReportPersonalization } from "./professional-profile";
import { ApiError } from "../http/api";
import { logger } from "../logger";
import type { PerformanceRun } from "../performance/pagespeed";
import { buildReportPdf } from "../report/pdf";
import type { ScanJob } from "../scanner/types";
import { hasResults } from "../scans/state-machine";
import type { Entitlements } from "../usage/entitlements";
import { consumeUsage } from "../usage/meter";
import { refundUsageSafe } from "../usage/refund";
import { toPublicScan, type OwnedScan } from "./scans";
type ScanViewer = OwnedScan["viewer"];
import { renderSummary } from "./views";

/**
 * Builds the PDF of a finished audit and returns it as a download response.
 * The export is metered (abuse allowance + credit cost, if configured) against
 * `payer` — the requesting owner, or the audit owner for share links — and
 * both are refunded if the build fails. An empty or partial file is never served.
 */
export async function auditPdfResponse(repo: Repository, scan: ScanJob, viewer: ScanViewer | undefined, payer: { principalId: string; ipHash: string }, ent: Entitlements, opts: { shared?: boolean; snapshot?: ClientReportSnapshot | null } = {}): Promise<Response> {
  if (!hasResults(scan.status) || !scan.summary) {
    throw new ApiError(409, "results_unavailable", scan.status === "failed" || scan.status === "cancelled" ? "This audit has no results to export." : "The audit has not finished yet.", { status: scan.status });
  }
  if (!ent.features.pdfExport) throw new ApiError(403, "feature_unavailable", "PDF exports are disabled on this deployment.", { feature: "pdfExport" });
  // Free-product conversion: no plan feature check and no credit charge. Only
  // the rolling technical window applies below.

  const snapshotContent = opts.snapshot?.content;
  let findings: Finding[];
  let renders: RenderSummary[];
  let perf: PerformanceRun[];
  if (snapshotContent) {
    findings = snapshotContent.findings;
    renders = snapshotContent.renders;
    perf = snapshotContent.performance;
  } else {
    const [liveFindings, renderArtifacts, performanceArtifacts] = await Promise.all([repo.listFindings(scan.id), repo.listArtifacts(scan.id, "render"), repo.listArtifacts(scan.id, "performance")]);
    findings = liveFindings;
    renders = renderArtifacts.map((a) => renderSummary(a.key, a.data as RenderResult));
    perf = performanceArtifacts.map((a) => a.data as PerformanceRun).sort((a, b) => Number(a.strategy !== "mobile") - Number(b.strategy !== "mobile"));
  }
  const usage = await consumeUsage(repo, payer, "pdf_export", ent);
  if (!usage.allowed) throw new ApiError(429, "pdf_limit_reached", "You have hit the PDF export limit for this window. Please try again a little later.", { resetAt: usage.resetAt, limit: usage.limit });

  let bytes: Uint8Array;
  try {
    const pub = toPublicScan(scan, viewer);
    let personalization = snapshotContent ? {
      professional: snapshotContent.professional,
      matchedServices: snapshotContent.matchedServices,
      portfolio: snapshotContent.portfolio,
    } : undefined;
    if (!snapshotContent && !opts.shared && scan.principalId.startsWith("user:")) {
      try {
        const data = await getAccountRepository().getProfessionalData(scan.principalId.slice(5));
        personalization = buildReportPersonalization(data, findings);
      } catch (err) {
        logger.warn("Professional profile was unavailable while building the PDF; using the standard report layout.", { scanId: scan.id, error: err instanceof Error ? err.message : "unknown" });
      }
    }
    bytes = await buildReportPdf({
      scan: snapshotContent?.scan ?? { ...pub, limits: scan.limits },
      findings,
      renders,
      performance: perf,
      generatedAt: opts.snapshot ? new Date(opts.snapshot.createdAt) : new Date(),
      personalization,
    });
    const head = new TextDecoder().decode(bytes.subarray(0, 5));
    if (bytes.byteLength < 1000 || head !== "%PDF-") throw new Error(`invalid PDF output (${bytes.byteLength} bytes)`);
  } catch (err) {
    logger.error("PDF report build failed", { scanId: scan.id, error: err instanceof Error ? err.message : "unknown" });
    await refundUsageSafe(repo, payer, "pdf_export");
    throw new ApiError(500, "pdf_failed", "The PDF report could not be created. Please try again; your export allowance was not used.");
  }

  const host = new URL(scan.targetUrl).hostname.replace(/[^a-z0-9.-]/gi, "");
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename="siteinsight-${host}-${scan.id.slice(0, 8)}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...(opts.shared ? { "X-Robots-Tag": "noindex, nofollow" } : {}),
    },
  });
}
