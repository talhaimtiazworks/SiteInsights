import { z } from "zod";

/**
 * Contract between the SiteInsights app and the browser worker (/worker).
 * Both sides validate with these schemas. Everything inside a result comes
 * from an untrusted website, so every list and string is capped.
 */
export const RENDER_PROTOCOL_VERSION = 1;

export const RENDER_CAPS = {
  links: 300,
  images: 120,
  console: 20,
  failedRequests: 30,
  axeViolations: 50,
  axeNodes: 10,
  jsonLd: 10,
  overflow: 10,
  tapTargets: 20,
  smallText: 15,
  text: 300,
  html: 400,
} as const;

const str = (max: number) => z.string().max(max);
const url = z.string().max(2048);

export const renderRequestSchema = z.object({
  version: z.literal(RENDER_PROTOCOL_VERSION).default(RENDER_PROTOCOL_VERSION),
  url: z.string().url().max(2048),
  viewport: z.enum(["mobile", "desktop"]).default("mobile"),
  navigationTimeoutMs: z.number().int().min(3000).max(60_000).default(20_000),
  /** Extra settle time after load/network-idle so late client rendering is captured. */
  settleMs: z.number().int().min(0).max(5000).default(1500),
  accessibility: z.boolean().default(false),
  allowedPorts: z.array(z.number().int().min(1).max(65535)).min(1).max(10).default([80, 443, 8080, 8443]),
  /** Hosts considered "internal" when classifying rendered links. */
  siteHosts: z.array(str(253)).min(1).max(10),
  userAgent: str(300).optional(),
  /** Hard cap on network requests the page may make (navigation + subresources). */
  maxRequests: z.number().int().min(10).max(500).default(200),
});
export type RenderRequest = z.infer<typeof renderRequestSchema>;
export type RenderRequestInput = z.input<typeof renderRequestSchema>;

export const renderErrorCodes = ["navigation_timeout", "navigation_failed", "blocked_destination", "http_error", "not_html", "crashed", "busy", "invalid_request", "internal"] as const;
export type RenderErrorCode = (typeof renderErrorCodes)[number];

const axeNodeSchema = z.object({
  target: z.array(str(500)).max(5),
  html: str(RENDER_CAPS.html),
  failureSummary: str(1000).nullable(),
});

export const axeViolationSchema = z.object({
  id: str(100),
  impact: z.enum(["minor", "moderate", "serious", "critical"]).nullable(),
  help: str(300),
  description: str(1000),
  helpUrl: str(500),
  tags: z.array(str(60)).max(30),
  nodeCount: z.number().int().min(0),
  nodes: z.array(axeNodeSchema).max(RENDER_CAPS.axeNodes),
});
export type AxeViolation = z.infer<typeof axeViolationSchema>;

export const renderResultSchema = z.object({
  version: z.number().int(),
  ok: z.boolean(),
  url,
  finalUrl: url.nullable(),
  status: z.number().int().nullable(),
  viewport: z.object({ name: z.enum(["mobile", "desktop"]), width: z.number().int(), height: z.number().int() }),
  readiness: z.enum(["network_idle", "load", "dom_content_loaded", "none"]),
  timing: z.object({ navigationMs: z.number().int().nullable(), totalMs: z.number().int() }),
  error: z.object({ code: z.enum(renderErrorCodes), message: str(500) }).nullable(),
  dom: z
    .object({
      title: str(300).nullable(),
      metaDescription: str(500).nullable(),
      canonical: url.nullable(),
      robotsMeta: str(200).nullable(),
      lang: str(40).nullable(),
      h1: z.array(str(160)).max(10),
      wordCount: z.number().int().min(0),
      htmlBytes: z.number().int().min(0),
      jsonLdCount: z.number().int().min(0),
      viewportMeta: str(300).nullable(),
    })
    .nullable(),
  links: z.array(z.object({ url, text: str(100), internal: z.boolean(), nofollow: z.boolean() })).max(RENDER_CAPS.links),
  linksTotal: z.number().int().min(0),
  images: z.array(z.object({ src: url, alt: str(150).nullable(), broken: z.boolean() })).max(RENDER_CAPS.images),
  console: z.array(z.object({ kind: z.enum(["error", "pageerror", "warning"]), text: str(RENDER_CAPS.text), source: url.nullable() })).max(RENDER_CAPS.console),
  consoleTotal: z.number().int().min(0),
  failedRequests: z
    .array(z.object({ url, resourceType: str(30), status: z.number().int().nullable(), failure: str(200).nullable(), blockedBySafety: z.boolean() }))
    .max(RENDER_CAPS.failedRequests),
  failedRequestsTotal: z.number().int().min(0),
  requestCount: z.number().int().min(0),
  blockedRequestCount: z.number().int().min(0),
  requestBudgetExceeded: z.boolean(),
  mobile: z
    .object({
      viewportWidth: z.number().int(),
      scrollWidth: z.number().int(),
      horizontalOverflow: z.boolean(),
      overflowing: z.array(z.object({ selector: str(300), right: z.number() })).max(RENDER_CAPS.overflow),
      tapTargetsChecked: z.number().int().min(0),
      smallTapTargets: z.array(z.object({ selector: str(300), text: str(100), width: z.number(), height: z.number() })).max(RENDER_CAPS.tapTargets),
      smallTapTargetsTotal: z.number().int().min(0),
      textNodesChecked: z.number().int().min(0),
      smallTextTotal: z.number().int().min(0),
      smallText: z.array(z.object({ selector: str(300), fontSize: z.number(), text: str(100) })).max(RENDER_CAPS.smallText),
    })
    .nullable(),
  axe: z
    .object({
      version: str(20),
      violations: z.array(axeViolationSchema).max(RENDER_CAPS.axeViolations),
      passes: z.number().int().min(0),
      incomplete: z.number().int().min(0),
    })
    .nullable(),
  axeError: str(300).nullable(),
});
export type RenderResult = z.infer<typeof renderResultSchema>;

/** Health endpoint payload (GET /healthz). */
export const workerHealthSchema = z.object({ ok: z.boolean(), version: z.number().int(), busy: z.number().int(), capacity: z.number().int(), browser: z.string().max(100).nullable() });
export type WorkerHealth = z.infer<typeof workerHealthSchema>;
