import type { Finding } from "../audit/types";
import type { PerformanceRun } from "../performance/pagespeed";
import type { RenderSummary } from "../services/views";
import type { ScanLimits, ScanState, ScanSummary, ScanStatus } from "../scanner/types";
import type { MatchedProfessionalService, PublishedPortfolioItem, PublishedProfessionalProfile } from "../professional/types";

/** Small, deliberately curated audit projection: no access keys, principal IDs or crawl state. */
export interface ReportScanSnapshot {
  id: string;
  targetUrl: string;
  status: ScanStatus;
  finishedAt: string | null;
  createdAt: string;
  warnings: string[];
  summary: ScanSummary | null;
  crawl: Pick<ScanState, "crawlTruncated" | "skipped">;
  limits: Pick<ScanLimits, "maxPages" | "maxDepth" | "maxLinksToCheck">;
}

/** Versioned, immutable payload consumed by both the public HTML and PDF renderers. */
export interface ClientReportSnapshotContent {
  schemaVersion: 1;
  scan: ReportScanSnapshot;
  findings: Finding[];
  renders: RenderSummary[];
  performance: PerformanceRun[];
  professional: PublishedProfessionalProfile | null;
  matchedServices: MatchedProfessionalService[];
  portfolio: PublishedPortfolioItem[];
}

export interface ClientReportSnapshot {
  id: string;
  userId: string;
  auditId: string;
  version: number;
  content: ClientReportSnapshotContent;
  createdAt: string;
}
