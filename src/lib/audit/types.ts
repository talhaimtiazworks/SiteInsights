import { z } from "zod";

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const severitySchema = z.enum(SEVERITIES);

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Informational",
};

export const CATEGORIES = ["links", "seo", "indexability", "accessibility", "security", "browser", "performance"] as const;
export type FindingCategory = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<FindingCategory, string> = {
  links: "Links",
  seo: "On-page SEO",
  indexability: "Crawling & indexing",
  accessibility: "Accessibility",
  security: "HTTPS & security",
  browser: "Rendering & mobile",
  performance: "Performance",
};

/** error = definite technical defect; recommendation = best practice; observation = informational / needs human review. */
export const FINDING_TYPES = ["error", "recommendation", "observation"] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

export const evidenceSchema = z.object({
  summary: z.string().min(1).max(1000),
  items: z.array(z.object({ label: z.string().max(120), value: z.string().max(1000) })).max(40).default([]),
  urls: z.array(z.string().max(2048)).max(50).default([]),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const findingSchema = z.object({
  id: z.string().min(1).max(80),
  scanId: z.string().min(1),
  ruleId: z.string().min(1).max(80),
  category: z.enum(CATEGORIES),
  type: z.enum(FINDING_TYPES),
  title: z.string().min(1).max(200),
  severity: severitySchema,
  description: z.string().min(1).max(2000),
  affectedUrl: z.string().max(2048),
  affectedUrls: z.array(z.string().max(2048)).max(200),
  affectedCount: z.number().int().min(0),
  evidence: evidenceSchema,
  detectionMethod: z.string().min(1).max(1000),
  recommendation: z.string().min(1).max(2000),
  aiExplanationAvailable: z.boolean(),
  createdAt: z.string(),
  /** Owner's triage state (stored with the issue; absent = open). */
  resolution: z
    .object({ status: z.enum(["open", "resolved", "ignored"]), resolvedAt: z.string().nullable(), note: z.string().max(500).nullable() })
    .optional(),
});
export const RESOLUTION_STATUSES = ["open", "resolved", "ignored"] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];
export type Finding = z.infer<typeof findingSchema>;

export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
