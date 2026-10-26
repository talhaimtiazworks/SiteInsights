import { z } from "zod";
import { severitySchema } from "../audit/types";

const str = (max: number) => z.string().trim().max(max);

export const issueExplanationSchema = z.object({
  plainLanguage: str(2000).min(1),
  impact: str(1500).min(1),
  recommendation: str(2500).min(1),
  steps: z.array(str(600)).max(10).default([]),
  exampleCode: z
    .object({ language: str(40).default("text"), code: str(5000).min(1), description: str(400).optional().default("") })
    .nullable()
    .optional()
    .default(null),
  priority: z.enum(["urgent", "high", "medium", "low"]),
  effort: z.enum(["quick", "moderate", "significant"]),
  confirmedFacts: z.array(str(500)).max(8).default([]),
  hypotheses: z.array(str(500)).max(8).default([]),
  limitations: str(1200).optional().default(""),
  severityAssessment: z.object({
    agreesWithScanner: z.boolean(),
    suggestedSeverity: severitySchema.nullable().optional().default(null),
    reasoning: str(1000).min(1),
  }),
});
export type IssueExplanation = z.infer<typeof issueExplanationSchema>;

export const auditSummarySchema = z.object({
  overview: str(2500).min(1),
  keyRisks: z.array(str(500)).max(8).default([]),
  priorities: z
    .array(
      z.object({
        title: str(200).min(1),
        findingIds: z.array(str(80)).max(20).default([]),
        reason: str(800).min(1),
        impact: z.enum(["high", "medium", "low"]),
        effort: z.enum(["quick", "moderate", "significant"]),
      }),
    )
    .max(8)
    .default([]),
  quickWins: z.array(str(400)).max(8).default([]),
  limitations: str(1500).optional().default(""),
});
export type AuditSummary = z.infer<typeof auditSummarySchema>;
