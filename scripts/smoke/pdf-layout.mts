#!/usr/bin/env node
/** Optional offline visual PDF evidence from a real JSON report plus a clearly labelled synthetic layout stress fixture.
 * Run from project root using the existing worker tsx: PDF_INPUT_JSON=/path/to/report.json PDF_OUT_DIR=/tmp/pdf-proof worker/node_modules/.bin/tsx scripts/smoke/pdf-layout.mts
 * No authentication, network calls, source edits or fabricated real-audit results.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildReportPdf, type PdfReportInput } from "../../src/lib/report/pdf";
import type { Finding } from "../../src/lib/audit/types";
const filename = process.env.PDF_INPUT_JSON;
assert(filename, "Privately set PDF_INPUT_JSON to an actual exported report JSON");
const json = JSON.parse(await readFile(filename, "utf8"));
const data = json.data ?? json;
assert(data.scan?.summary && Array.isArray(data.findings), "Input must contain an actual scan summary and findings");
const output = process.env.PDF_OUT_DIR ?? "/tmp/siteinsights-pdf-proof";
await mkdir(output, { recursive: true });
const input: PdfReportInput = { scan: data.scan, findings: data.findings, performance: data.performance ?? [], renders: data.renders ?? [], generatedAt: new Date() };
await writeFile(path.join(output, "actual-data-report.pdf"), await buildReportPdf(input));
const id = randomUUID();
const longUrl = `https://pdf-layout-fixture.invalid/${"long-path-segment/".repeat(70)}?query=${"x".repeat(400)}`;
const createdAt = new Date().toISOString();
const findings: Finding[] = Array.from({ length: 16 }, (_, index) => ({
  id: `synthetic-${index}`, scanId: id, ruleId: "layout.fixture", category: "seo", type: "observation", severity: (["critical", "high", "medium", "low", "info"] as const)[index % 5],
  title: `SYNTHETIC layout item ${index + 1} — 日本語 タイトル اردو متن العربية 🚀 Café Łódź`,
  description: "This is synthetic pagination and Unicode evidence, NOT a real website finding. ".repeat(index === 0 ? 80 : 3),
  affectedUrl: longUrl, affectedUrls: [longUrl], affectedCount: 1,
  evidence: { summary: "SYNTHETIC fixture: verify complete long URLs, Unicode glyphs, headers, footer and multi-page row boundaries.", items: [{ label: "Long URL", value: longUrl }, { label: "Unicode", value: "日本語 中文 한국어 اردو العربية 🚀 ✔ Łódź — é" }], urls: [longUrl] },
  detectionMethod: "Synthetic layout fixture, not a crawler result", recommendation: "Inspect pagination and text rendering only; no website remediation is implied.", aiExplanationAvailable: false, createdAt,
}));
const fixture: PdfReportInput = { ...input, generatedAt: new Date(), findings, scan: { ...input.scan, id, targetUrl: "https://pdf-layout-fixture.invalid/", warnings: ["SYNTHETIC PDF LAYOUT FIXTURE — NOT A REAL AUDIT. Summary values are carried from the separate real input solely to exercise existing report sections."], summary: { ...input.scan.summary!, totalFindings: findings.length, findingsBySeverity: { critical: 4, high: 3, medium: 3, low: 3, info: 3 } } } };
const started = Date.now();
const bytes = await buildReportPdf(fixture);
await writeFile(path.join(output, "synthetic-pagination-unicode-fixture.pdf"), bytes);
console.log(JSON.stringify({ actualFindings: input.findings.length, syntheticItems: findings.length, syntheticBytes: bytes.length, generationMs: Date.now() - started, output }, null, 2));
