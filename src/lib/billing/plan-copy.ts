/**
 * Display copy derived from the authoritative plan catalog, so marketing pages
 * can never advertise a limit that differs from what the server enforces.
 */
import { estimateAuditCredits, formatCredits, type CreditCosts, type PlanDefinition, type PlanId } from "./plans";

export function fullAuditsPerMonth(p: PlanDefinition, costs: CreditCosts): number {
  const cost = estimateAuditCredits(costs, p.maxPagesPerAudit);
  return cost > 0 ? Math.floor(p.monthlyCredits / cost) : 0;
}

export function planBullets(p: PlanDefinition): string[] {
  const out = [`${formatCredits(p.monthlyCredits)} credits every month`, `Up to ${formatCredits(p.maxPagesPerAudit)} pages per audit, ${p.maxDepth} clicks deep`, `${formatCredits(p.maxLinksToCheck)} link destinations checked per audit`];
  if (p.id === "free") out.push("Broken-link, technical SEO, accessibility and HTTPS checks", "Findings with evidence, JSON export");
  if (p.features.pdfExport) out.push("Branded PDF reports");
  if (p.features.aiExplanations) out.push("AI explanations of verified findings");
  if (p.features.prospects) out.push(`Prospect list (up to ${formatCredits(p.maxProspects)}) with status, notes and CSV export`);
  if (p.features.shareLinks) out.push("Expiring, revocable client report links");
  if (p.features.batchAudits) out.push(`Batch audits of up to ${p.maxBatchSize} sites, run one after another`);
  if (p.features.advancedFilters) out.push("Opportunity ranking and advanced filters");
  out.push(`${formatCredits(p.historyLimit)} audits kept in history`);
  return out;
}

export type CompareCell = string | boolean;
export interface CompareRow {
  label: string;
  hint?: string;
  values: Record<PlanId, CompareCell>;
}

export function comparisonRows(plans: Record<PlanId, PlanDefinition>, costs: CreditCosts): Array<{ group: string; rows: CompareRow[] }> {
  const row = (label: string, f: (p: PlanDefinition) => CompareCell, hint?: string): CompareRow => ({ label, hint, values: { free: f(plans.free), pro: f(plans.pro), business: f(plans.business) } });
  const minutes = (ms: number) => `${Math.round(ms / 60000)} min`;
  return [
    {
      group: "Audits",
      rows: [
        row("Monthly credits", (p) => formatCredits(p.monthlyCredits)),
        row("Pages per audit", (p) => formatCredits(p.maxPagesPerAudit)),
        row("Full-size audits per month", (p) => String(fullAuditsPerMonth(p, costs)), "At the plan's page limit. Smaller audits cost less."),
        row("Crawl depth", (p) => `${p.maxDepth} clicks`),
        row("Links checked per audit", (p) => formatCredits(p.maxLinksToCheck)),
        row("Time budget per audit", (p) => minutes(p.maxDurationMs)),
        row("Audits running at once", (p) => String(p.maxConcurrentAudits)),
        row("Audits started per day", (p) => formatCredits(p.auditsPerDay), "Abuse protection on top of credits."),
        row("Audit history", (p) => formatCredits(p.historyLimit)),
      ],
    },
    {
      group: "Reports",
      rows: [
        row("Findings with evidence", () => true),
        row("JSON export", (p) => p.features.jsonExport),
        row("Branded PDF report", (p) => p.features.pdfExport),
        row("AI explanations", (p) => (p.features.aiExplanations ? `${costs.aiRequest} credits each` : false), "Only when an AI provider is configured on the server."),
        row("Client report links", (p) => p.features.shareLinks),
      ],
    },
    {
      group: "Client work",
      rows: [
        row("Prospect list, notes and status", (p) => (p.features.prospects ? `Up to ${formatCredits(p.maxProspects)}` : false)),
        row("Prospect CSV export", (p) => p.features.prospects),
        row("Opportunity ranking and filters", (p) => p.features.advancedFilters),
        row("Batch audits", (p) => (p.features.batchAudits ? `Up to ${p.maxBatchSize} sites` : false), "Queued and run one after another, not in parallel."),
      ],
    },
  ];
}
