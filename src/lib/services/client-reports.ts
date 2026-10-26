import "server-only";
import type { AccountRepository } from "../db/account-types";
import type { Repository } from "../db/types";
import { renderSummary } from "./views";
import type { PerformanceRun } from "../performance/pagespeed";
import type { RenderResult } from "../browser/protocol";
import type { ScanJob } from "../scanner/types";
import type { ClientReportSnapshotContent } from "../report/snapshot-types";
import { buildReportPersonalization, emptyProfessionalData } from "./professional-profile";

/** Freeze the verified report evidence plus only the professional fields the owner explicitly published. */
export async function buildClientReportSnapshotContent(repo: Repository, accounts: AccountRepository | null, userId: string, scan: ScanJob): Promise<ClientReportSnapshotContent> {
  const [allFindings, renderArtifacts, performanceArtifacts, professionalData] = await Promise.all([
    repo.listFindings(scan.id),
    repo.listArtifacts(scan.id, "render"),
    repo.listArtifacts(scan.id, "performance"),
    accounts ? accounts.getProfessionalData(userId) : Promise.resolve(emptyProfessionalData()),
  ]);
  const findings = allFindings.filter((f) => f.resolution?.status !== "ignored");
  const personalization = buildReportPersonalization(professionalData, findings);
  const skipped = scan.state?.skipped;
  return {
    schemaVersion: 1,
    scan: {
      id: scan.id,
      targetUrl: scan.targetUrl,
      status: scan.status,
      finishedAt: scan.finishedAt,
      createdAt: scan.createdAt,
      warnings: scan.warnings ?? [],
      summary: scan.summary,
      crawl: {
        crawlTruncated: !!scan.state?.crawlTruncated,
        skipped: { robots: skipped?.robots ?? 0, limit: skipped?.limit ?? 0, traps: skipped?.traps ?? 0, offHost: skipped?.offHost ?? 0, depth: skipped?.depth ?? 0 },
      },
      limits: { maxPages: scan.limits.maxPages, maxDepth: scan.limits.maxDepth, maxLinksToCheck: scan.limits.maxLinksToCheck },
    },
    findings,
    renders: renderArtifacts.map((a) => renderSummary(a.key, a.data as RenderResult)),
    performance: performanceArtifacts.map((a) => a.data as PerformanceRun).sort((a, b) => Number(a.strategy !== "mobile") - Number(b.strategy !== "mobile")),
    ...personalization,
  };
}
