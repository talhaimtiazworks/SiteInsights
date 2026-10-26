import type { Finding } from "../audit/types";
import type { ProviderId } from "../config/env";
import type { PageRecord, ScanJob } from "../scanner/types";
import { buildIssuePrompt, buildSummaryPrompt, issueSystemPrompt, summarySystemPrompt } from "./prompts";
import { auditSummarySchema, issueExplanationSchema, type AuditSummary, type IssueExplanation } from "./schemas";
import { generateStructured } from "./structured";
import type { AIProvider } from "./types";
import type { z } from "zod";

export interface AiRunMeta {
  provider: ProviderId;
  model: string;
  /** Always null: automatic cross-provider failover was removed with owner keys (strict BYOK — only the user's chosen provider is called). */
  fallbackFrom: null;
  fallbackReason: null;
  attempts: number;
}

export interface AiLimits {
  maxInputChars: number;
  maxOutputTokens: number;
  maxRetries: number;
}

/**
 * Explains one verified finding using the request-scoped provider built from
 * the current user's own key. Bounded retries (limits.maxRetries) apply only
 * to transient failures — invalid credentials/exhausted quota fail immediately
 * and never silently consume more of the user's provider credits.
 */
export async function explainFinding(provider: AIProvider, scan: Pick<ScanJob, "targetUrl">, finding: Finding, page: PageRecord | undefined, limits: AiLimits): Promise<{ explanation: IssueExplanation; meta: AiRunMeta }> {
  const user = buildIssuePrompt(scan, finding, page, limits.maxInputChars);
  const { data, meta, attempts } = await generateStructured(provider, { system: issueSystemPrompt(), user, maxOutputTokens: limits.maxOutputTokens }, issueExplanationSchema as z.ZodType<IssueExplanation>, { maxRetries: limits.maxRetries });
  const explanation = { ...data };
  // A "suggestion" equal to the scanner's severity is not an adjustment.
  if (explanation.severityAssessment.suggestedSeverity === finding.severity) {
    explanation.severityAssessment = { ...explanation.severityAssessment, agreesWithScanner: true, suggestedSeverity: null };
  }
  if (explanation.severityAssessment.agreesWithScanner) explanation.severityAssessment.suggestedSeverity = null;
  return { explanation, meta: { provider: meta.provider, model: meta.model, fallbackFrom: null, fallbackReason: null, attempts } };
}

export async function summarizeAudit(provider: AIProvider, scan: ScanJob, findings: Finding[], limits: AiLimits): Promise<{ summary: AuditSummary & { omittedFindings: number; droppedUnsupported: number }; meta: AiRunMeta }> {
  const { prompt, omitted } = buildSummaryPrompt(scan, findings, limits.maxInputChars);
  const { data, meta, attempts } = await generateStructured(provider, { system: summarySystemPrompt(), user: prompt, maxOutputTokens: limits.maxOutputTokens }, auditSummarySchema as z.ZodType<AuditSummary>, { maxRetries: limits.maxRetries });
  // Unsupported-claim guard: priorities must reference real finding IDs from THIS scan.
  const known = new Set(findings.map((f) => f.id));
  let dropped = 0;
  const priorities = data.priorities
    .map((p) => ({ ...p, findingIds: p.findingIds.filter((id) => known.has(id)) }))
    .filter((p) => {
      if (p.findingIds.length === 0) {
        dropped++;
        return false;
      }
      return true;
    });
  return { summary: { ...data, priorities, omittedFindings: omitted, droppedUnsupported: dropped }, meta: { provider: meta.provider, model: meta.model, fallbackFrom: null, fallbackReason: null, attempts } };
}
