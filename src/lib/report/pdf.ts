import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import tokens from "../design-tokens.json";
import { BRAND, brandCopyright } from "../brand";
import { PDFArray, PDFDocument, PDFName, PDFString, rgb, StandardFonts, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { CATEGORIES, CATEGORY_LABELS, SEVERITIES, SEVERITY_LABELS, SEVERITY_ORDER, type Finding, type Severity } from "../audit/types";
import type { PerformanceRun } from "../performance/pagespeed";
import type { RenderSummary } from "../services/views";
import type { ScanSummary } from "../scanner/types";
import type { MatchedProfessionalService, PublishedPortfolioItem, PublishedProfessionalProfile } from "../professional/types";
import { decodeLogoDataUrl } from "../professional/logo";
import { fullyDecodeLogoDataUrl } from "../professional/logo-validation";
import { ACCESSIBILITY_DISCLAIMER, clause, coverageRows, priorityFindings } from "./summary";

/**
 * Server-side report: standard Helvetica for Latin text, with locally bundled
 * static TrueType fallbacks embedded only when needed. The official PNG is embedded;
 * there are no browser, network, temporary-file or credential dependencies.
 */

export interface PdfReportInput {
  scan: {
    id: string;
    targetUrl: string;
    status: string;
    finishedAt: string | null;
    createdAt: string;
    warnings: string[];
    summary: ScanSummary | null;
    crawl: { crawlTruncated: boolean; skipped: { robots: number; limit: number; depth: number; traps: number } };
    limits: { maxPages: number; maxDepth: number; maxLinksToCheck: number };
  };
  findings: Finding[];
  performance: PerformanceRun[];
  renders: RenderSummary[];
  generatedAt: Date;
  /** Optional, explicitly published account profile plus deterministic finding matches. */
  personalization?: { professional: PublishedProfessionalProfile | null; matchedServices: MatchedProfessionalService[]; portfolio: PublishedPortfolioItem[] };
  /** Deprecated compatibility option: all findings are now written in full. */
  maxDetailedFindings?: number;
}

// ------------------------------------------------------------------ text safety
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const REPLACEMENTS: Record<string, string> = {
  "\u2192": "->", "\u2190": "<-", "\u2264": "<=", "\u2265": ">=", "\u2248": "~", "\u2260": "!=", "\u2212": "-", "\u2011": "-", "\u2010": "-",
  "\u00a0": " ", "\u2009": " ", "\u200a": " ", "\u202f": " ", "\u2007": " ", "\u2002": " ", "\u2003": " ", "\u2713": "OK", "\u2714": "OK", "\u2717": "x", "\u2715": "x", "\u2197": "",
};

/** Makes any string safe for the PDF standard fonts (WinAnsi). */
export function pdfText(input: unknown): string {
  const s = String(input ?? "").normalize("NFC");
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\t" || ch === "\n" || ch === "\r") out += " ";
    else if (code >= 0x20 && code <= 0x7e) out += ch;
    else if (code >= 0xa1 && code <= 0xff && code !== 0xad) out += ch;
    else if (WIN_ANSI_EXTRA.has(ch)) out += ch;
    else if (REPLACEMENTS[ch] !== undefined) out += REPLACEMENTS[ch];
    else if (code < 0x20 || (code >= 0x7f && code < 0xa0) || code === 0xad || (code >= 0x200b && code <= 0x200f) || code === 0xfeff) continue;
    else {
      // Try stripping accents (e.g. "ł" has none, "ő" -> "o"), else "?".
      const base = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      out += base && base !== ch && /^[\x20-\x7e]+$/.test(base) ? base : "?";
    }
  }
  return out;
}

// ------------------------------------------------------------------ layout
const A4 = { w: 595.28, h: 841.89 };
const M = { top: 56, bottom: 56, left: 50, right: 50 };
const CONTENT_W = A4.w - M.left - M.right;

const hex = (value: string) => rgb(parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255, parseInt(value.slice(5, 7), 16) / 255);
const safePalette = (values: unknown): Array<{ hex: string; color: RGB }> => {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: Array<{ hex: string; color: RGB }> = [];
  for (const value of values) {
    if (typeof value !== "string" || !/^#[\da-fA-F]{6}$/.test(value)) continue;
    const canonical = value.toUpperCase();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ hex: canonical, color: hex(canonical) });
    if (out.length === 10) break;
  }
  return out;
};
const P = tokens.colors;
const C = { text: hex(P.text), muted: hex(P.secondary), line: hex(P.border), primary: hex(P.primary), cyan: hex(P.accent), soft: hex(P.champagne), white: hex(P.white), good: hex(P.success), warn: hex(P.warning), bad: hex(P.danger) };
const SEV_COLOR: Record<Severity, RGB> = { critical: C.bad, high: C.bad, medium: C.warn, low: hex(P.info), info: C.muted };
const assetReaders = {
  logo: () => readFile(path.join(process.cwd(), "public/brand/talhaimtiazworks-logo-640.png")),
  // Product typefaces (OFL, static subset instances; see scripts/brand/fonts/ui/provenance.json).
  body: () => readFile(path.join(process.cwd(), "scripts/brand/fonts/ui/Inter-Regular.ttf")),
  bodyBold: () => readFile(path.join(process.cwd(), "scripts/brand/fonts/ui/Inter-SemiBold.ttf")),
  display: () => readFile(path.join(process.cwd(), "scripts/brand/fonts/ui/BricolageGrotesque-SemiBold.ttf")),
  mono: () => readFile(path.join(process.cwd(), "scripts/brand/fonts/ui/JetBrainsMono-Regular.ttf")),
  arabic: () => readFile(path.join(process.cwd(), "scripts/brand/fonts/NotoSansArabic.ttf")),
  emoji: () => readFile(path.join(process.cwd(), "scripts/brand/fonts/NotoEmoji.ttf")),
  korean: () => readFile(path.join(process.cwd(), "scripts/brand/fonts/NotoSansKR.ttf")),
  cjk: () => readFile(path.join(process.cwd(), "scripts/brand/fonts/NotoSansSC.ttf")),
};
const assetCache = new Map<string, Promise<Buffer>>();
function asset(name: keyof typeof assetReaders) {
  let pending = assetCache.get(name);
  if (!pending) { pending = assetReaders[name](); assetCache.set(name, pending); }
  return pending;
}

async function embedProfileLogo(doc: PDFDocument, value: string | undefined): Promise<PDFImage | null> {
  const decoded = decodeLogoDataUrl(value);
  if (!decoded || !(await fullyDecodeLogoDataUrl(value))) return null;
  try { return decoded.mimeType === "image/png" ? await doc.embedPng(decoded.bytes) : await doc.embedJpg(decoded.bytes); }
  catch { return null; }
}

class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  private charsets = new Map<PDFFont, Set<number>>();
  constructor(public doc: PDFDocument, public font: PDFFont, public bold: PDFFont, public mono: PDFFont, public logo: PDFImage, public fallbacks: PDFFont[], public display: PDFFont = bold, public accent: RGB = C.primary) {
    for (const f of [font, bold, mono, display, ...fallbacks]) this.charsets.set(f, new Set(f.getCharacterSet()));
    this.addPage();
  }

  addPage() {
    this.page = this.doc.addPage([A4.w, A4.h]);
    this.pages.push(this.page);
    this.y = A4.h - M.top;
    if (this.pages.length > 1) {
      this.page.drawImage(this.logo, { x: M.left, y: this.y - 25, width: 25, height: 25 });
      this.page.drawText(`${BRAND.name}  /  ${BRAND.parent}`, { x: M.left + 33, y: this.y - 14, size: 8.5, font: this.bold, color: C.primary });
      this.page.drawLine({ start: { x: M.left, y: this.y - 33 }, end: { x: A4.w - M.right, y: this.y - 33 }, color: C.cyan, thickness: 1 });
      this.y -= 45;
    }
  }

  ensure(h: number) { if (this.y - h < M.bottom) this.addPage(); }
  gap(h: number) { this.y -= h; }

  /** Normalize controls, never silently replace a finding's non-Latin content with '?'. */
  private safe(value: string): string {
    const text = value.normalize("NFC").replace(/[\t\r\n]/g, " ").replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
    return Array.from(text, (ch) => [...this.charsets.values()].some((set) => set.has(ch.codePointAt(0)!)) ? ch : REPLACEMENTS[ch] ?? `[U+${ch.codePointAt(0)!.toString(16).toUpperCase()}]`).join("");
  }

  private runs(text: string, base: PDFFont): Array<{ text: string; font: PDFFont }> {
    const result: Array<{ text: string; font: PDFFont }> = [];
    // Keep an Arabic/Urdu phrase (including its internal spaces) in one shaping
    // run. Splitting it at each Latin space would reverse word order incorrectly.
    for (const ch of text.match(/[\u0600-\u08ff]+(?: +[\u0600-\u08ff]+)*|[\s\S]/gu) ?? []) {
      const code = ch.codePointAt(0)!;
      const font = this.charsets.get(base)!.has(code) ? base : this.fallbacks.find((f) => this.charsets.get(f)!.has(code)) ?? base;
      const last = result[result.length - 1];
      if (last?.font === font) last.text += ch;
      else result.push({ text: ch, font });
    }
    return result;
  }

  /** Advance widths per character at 1000 units. pdf-lib's widthOfTextAtSize runs full shaping on every call, which made wrapping long URLs quadratic. */
  private advance = new Map<PDFFont, Map<string, number>>();
  private runWidth(text: string, font: PDFFont, size: number) {
    // Contextual scripts (Arabic) need shaping for correct widths; Latin/CJK fonts are measured per character.
    if (this.fallbacks.includes(font) && /[\u0600-\u08ff]/u.test(text)) return font.widthOfTextAtSize(text, size);
    let cache = this.advance.get(font);
    if (!cache) this.advance.set(font, (cache = new Map()));
    let units = 0;
    for (const ch of text) {
      let w = cache.get(ch);
      if (w === undefined) cache.set(ch, (w = font.widthOfTextAtSize(ch, 1000)));
      units += w;
    }
    return (units * size) / 1000;
  }

  measure(text: string, font: PDFFont, size: number) {
    return this.runs(text, font).reduce((width, run) => width + this.runWidth(run.text, run.font, size), 0);
  }

  private draw(text: string, x: number, y: number, size: number, font: PDFFont, color: RGB, link?: string) {
    let cursor = x;
    for (const run of this.runs(text, font)) {
      this.page.drawText(run.text, { x: cursor, y, size, font: run.font, color });
      cursor += this.runWidth(run.text, run.font, size);
    }
    if (link && /^https?:\/\//i.test(link)) {
      try {
        const uri = new URL(link).href;
        const annotation = this.doc.context.register(this.doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [x, y - 2, Math.max(x + 1, cursor), y + size], Border: [0, 0, 0], A: { Type: "Action", S: "URI", URI: PDFString.of(uri) } }));
        const key = PDFName.of("Annots");
        const annotations = this.page.node.lookupMaybe(key, PDFArray) ?? this.doc.context.obj([]);
        annotations.push(annotation);
        this.page.node.set(key, annotations);
      } catch { /* An invalid URL is still shown as evidence, never made executable. */ }
    }
  }

  /** Width-aware wrapping, including arbitrarily long URL tokens and Unicode code points. */
  wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const words = this.safe(text).split(/ +/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    const fits = (value: string) => this.measure(value, font, size) <= width;
    for (const word of words) {
      if (!fits(word)) {
        if (line) { lines.push(line); line = ""; }
        let remaining = Array.from(word);
        while (remaining.length && !fits(remaining.join(""))) {
          let lo = 1, hi = remaining.length;
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (fits(remaining.slice(0, mid).join(""))) lo = mid;
            else hi = mid - 1;
          }
          lines.push(remaining.slice(0, lo).join(""));
          remaining = remaining.slice(lo);
        }
        line = remaining.join("");
        continue;
      }
      const next = line ? `${line} ${word}` : word;
      if (fits(next)) line = next;
      else { if (line) lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }

  text(text: string, o: { size?: number; font?: PDFFont; color?: RGB; x?: number; width?: number; lineGap?: number; maxLines?: number; link?: string } = {}) {
    const size = o.size ?? 10;
    const font = o.font ?? this.font;
    const x = o.x ?? M.left;
    const width = o.width ?? CONTENT_W - (x - M.left);
    const lh = size * (1.45 + (o.lineGap ?? 0));
    for (const line of this.wrap(text, font, size, width)) {
      this.ensure(lh);
      this.draw(line, x, this.y - size, size, font, o.color ?? C.text, o.link);
      this.y -= lh;
    }
  }

  heading(text: string, level: 1 | 2 = 1) {
    const size = level === 1 ? 15 : 11.5;
    this.ensure(size * 2 + 40);
    this.gap(level === 1 ? 16 : 8);
    this.text(text, { size, font: level === 1 ? this.display : this.bold, color: level === 1 ? this.accent : C.text });
    if (level === 1) {
      this.page.drawLine({ start: { x: M.left, y: this.y + 1 }, end: { x: A4.w - M.right, y: this.y + 1 }, thickness: .6, color: C.line });
      this.gap(7);
    } else this.gap(2);
  }

  /** Table rows split across pages instead of clipping when a cell contains a very long URL. */
  row(cells: Array<{ text: string; width: number; font?: PDFFont; color?: RGB; size?: number; align?: "left" | "right" }>, o: { fill?: RGB; pad?: number } = {}) {
    const pad = o.pad ?? 5;
    const wrapped = cells.map((cell) => this.wrap(cell.text, cell.font ?? this.font, cell.size ?? 9.5, cell.width - 10));
    const lh = Math.max(...cells.map((cell) => cell.size ?? 9.5)) * 1.45;
    const total = Math.max(...wrapped.map((lines) => lines.length));
    let offset = 0;
    while (offset < total) {
      const capacity = Math.floor((this.y - M.bottom - 2 * pad) / lh);
      if (capacity < 1) { this.addPage(); continue; }
      const count = Math.min(capacity, total - offset);
      const height = count * lh + pad * 2;
      if (o.fill) this.page.drawRectangle({ x: M.left, y: this.y - height, width: CONTENT_W, height, color: o.fill });
      let x = M.left;
      cells.forEach((cell, index) => {
        const size = cell.size ?? 9.5;
        const font = cell.font ?? this.font;
        wrapped[index].slice(offset, offset + count).forEach((line, j) => {
          const tx = cell.align === "right" ? x + cell.width - 5 - this.measure(line, font, size) : x + 5;
          this.draw(line, tx, this.y - pad - size - j * lh, size, font, cell.color ?? C.text, /^https?:\/\//i.test(cell.text) ? cell.text : undefined);
        });
        x += cell.width;
      });
      this.y -= height;
      this.page.drawLine({ start: { x: M.left, y: this.y }, end: { x: A4.w - M.right, y: this.y }, thickness: .4, color: C.line });
      offset += count;
      if (offset < total) this.addPage();
    }
  }
}

const fmtDate = (iso: string | null | Date) => {
  if (!iso) return "-";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};
const fmtMs = (v: number | null) => (v === null ? "-" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const fmtDuration = (ms: number) => (ms >= 59_500 ? `${Math.floor(Math.round(ms / 1000) / 60)} min ${Math.round(ms / 1000) % 60} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

// ------------------------------------------------------------------ builder
/**
 * pdf-lib draws glyph advances without GPOS positioning, so contextual
 * substitutions/kerning add nothing visible but make fontkit shaping ~20x
 * slower (Inter and JetBrains Mono have large calt tables). Ligatures are
 * also off so extracted/copied text maps 1:1 to characters.
 */
const LATIN_FEATURES_OFF = { liga: false, clig: false, calt: false, kern: false, ccmp: false, locl: false, mark: false, mkmk: false };

export async function buildReportPdf(input: PdfReportInput): Promise<Uint8Array> {
  const { scan, generatedAt } = input;
  const s = scan.summary;
  if (!s) throw new Error("Report has no summary");
  const host = new URL(scan.targetUrl).hostname;

  const doc = await PDFDocument.create();
  doc.setTitle(pdfText(`SiteInsights report - ${host}`));
  doc.setAuthor(BRAND.parent);
  doc.setCreator(`${BRAND.name} — ${BRAND.attribution}`);
  doc.setProducer("SiteInsights (pdf-lib)");
  doc.setSubject(`Website audit of ${scan.targetUrl}`);
  doc.setCreationDate(generatedAt);
  doc.setModificationDate(generatedAt);

  doc.registerFontkit(fontkit);
  // Same typefaces as the web app; fall back to the PDF standard fonts if a font file is missing.
  const embed = async (name: "body" | "bodyBold" | "display" | "mono", fallback: StandardFonts) => {
    try {
      return await doc.embedFont(await asset(name), { subset: true, features: LATIN_FEATURES_OFF });
    } catch {
      assetCache.delete(name);
      return doc.embedFont(fallback);
    }
  };
  const regular = await embed("body", StandardFonts.Helvetica);
  const bold = await embed("bodyBold", StandardFonts.HelveticaBold);
  const display = await embed("display", StandardFonts.HelveticaBold);
  const mono = await embed("mono", StandardFonts.Courier);
  const logo = await doc.embedPng(await asset("logo"));
  const palette = safePalette(input.personalization?.professional?.brandColors);
  const accent = palette[0]?.color ?? C.primary;
  const clientLogo = await embedProfileLogo(doc, input.personalization?.professional?.logoDataUrl);
  const strings = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === "string") strings.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(input);
  const latin = new Set(regular.getCharacterSet());
  const unsupportedSet = new Set<string>();
  for (const text of strings) for (const ch of text) if (ch.codePointAt(0)! > 31 && !latin.has(ch.codePointAt(0)!)) unsupportedSet.add(ch);
  const unsupported = [...unsupportedSet];
  // Whole static TrueType CJK/emoji embedding avoids malformed subset outlines.
  // Arabic is subset separately so contextual glyph widths/ToUnicode are retained.
  // Both paths are verified with real rendered PDF evidence.
  const fallbacks: PDFFont[] = [];
  if (unsupported.some((ch) => /[\u0600-\u08ff]/u.test(ch))) fallbacks.push(await doc.embedFont(await asset("arabic"), { subset: true }));
  if (unsupported.some((ch) => /[\u{1F000}-\u{1FAFF}]/u.test(ch))) fallbacks.push(await doc.embedFont(await asset("emoji"), { subset: false }));
  if (unsupported.some((ch) => /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(ch))) fallbacks.push(await doc.embedFont(await asset("korean"), { subset: false }));
  if (unsupported.some((ch) => !fallbacks.some((font) => font.getCharacterSet().includes(ch.codePointAt(0)!)))) fallbacks.push(await doc.embedFont(await asset("cjk"), { subset: false }));
  const w = new Writer(doc, regular, bold, mono, logo, fallbacks, display, accent);

  // The entire supplied logo is embedded at its original 1:1 aspect ratio.
  w.page.drawRectangle({ x: 0, y: A4.h - 128, width: A4.w, height: 128, color: accent });
  w.page.drawImage(logo, { x: M.left, y: w.y - 62, width: 70, height: 70 });
  w.page.drawText(BRAND.parent, { x: M.left + 86, y: w.y - 12, size: 19, font: w.display, color: C.white });
  w.page.drawText(`${BRAND.name} / Website audit report`, { x: M.left + 86, y: w.y - 33, size: 11, font: w.font, color: C.white });
  w.page.drawText(BRAND.attribution, { x: M.left + 86, y: w.y - 50, size: 8.5, font: w.font, color: C.cyan });
  w.gap(104);
  w.text(scan.targetUrl, { size: 17, font: w.display, lineGap: 0.05, link: scan.targetUrl });
  w.gap(4);
  w.text(`Scanned ${fmtDate(scan.finishedAt ?? scan.createdAt)}  |  ${s.pagesScanned} URLs fetched, ${s.htmlPages} HTML pages  |  took ${fmtDuration(s.durationMs)}  |  status: ${scan.status.replace(/_/g, " ")}`, { size: 9.5, color: C.muted });
  w.text(`Audit created ${fmtDate(scan.createdAt)}`, { size: 8.5, color: C.muted });
  w.text(`Report generated ${fmtDate(generatedAt)}  |  Audit ID ${scan.id}`, { size: 8.5, color: C.muted });

  const professional = input.personalization?.professional ?? null;
  const matchedServices = input.personalization?.matchedServices ?? [];
  const portfolio = input.personalization?.portfolio ?? [];
  if (professional || matchedServices.length || portfolio.length) {
    w.heading("Professional profile", 2);
    if (clientLogo) {
      w.ensure(56);
      const logoScale = Math.min(44 / clientLogo.width, 44 / clientLogo.height);
      const logoWidth = clientLogo.width * logoScale;
      const logoHeight = clientLogo.height * logoScale;
      w.page.drawImage(clientLogo, { x: M.left + (44 - logoWidth) / 2, y: w.y - 48 + (44 - logoHeight) / 2, width: logoWidth, height: logoHeight });
      w.y -= 52;
    }
    const profileTypeLabel = professional?.profileType === "agency" ? "Agency" : professional?.profileType === "freelancer" ? "Freelancer" : "";
    const identity = [professional?.professionalName, professional?.businessName, professional?.jobTitle, profileTypeLabel].filter(Boolean).join(" · ");
    if (identity) w.text(identity, { font: w.bold, size: 10.5 });
    if (professional?.headline) w.text(professional.headline, { size: 10 });
    if (professional?.biography) w.text(professional.biography, { size: 9.5, color: C.muted });
    if (professional?.websiteUrl) w.text(`Website: ${professional.websiteUrl}`, { size: 9, color: accent, link: professional.websiteUrl });
    const contacts = [professional?.contactEmail ? `Email: ${professional.contactEmail}` : "", professional?.contactPhone ? `Phone: ${professional.contactPhone}` : "", professional?.location ? `Location: ${professional.location}` : ""].filter(Boolean);
    if (contacts.length) w.text(contacts.join("  |  "), { size: 8.5, color: C.muted });
    if (palette.length) {
      w.gap(4);
      w.text("Published brand colors", { size: 8.5, color: C.muted });
      const swatchColumns = 6;
      const swatchRows = Math.ceil(palette.length / swatchColumns);
      w.ensure(swatchRows * 18 + 4);
      palette.forEach((color, i) => {
        const x = M.left + (i % swatchColumns) * 82;
        const y = w.y - 13 - Math.floor(i / swatchColumns) * 18;
        w.page.drawRectangle({ x, y, width: 25, height: 10, color: color.color });
        w.page.drawText(color.hex, { x: x + 29, y: y - 1, size: 7.5, font: w.mono, color: C.muted });
      });
      w.gap(swatchRows * 18 + 4);
    }
    w.text("Profile details shown here were explicitly selected for publication by the account owner.", { size: 8, color: C.muted });
  }

  if (matchedServices.length) {
    w.heading("Services matched to verified findings");
    w.text("A deterministic match of published services to open findings from this audit. Matching does not verify provider credentials, guarantee results or imply that work has been completed.", { size: 8.5, color: C.muted });
    for (const service of matchedServices) {
      w.heading(service.title, 2);
      if (service.description) w.text(service.description, { size: 9.5 });
      if (service.matchedFindings.length) w.text(`Verified audit findings: ${service.matchedFindings.map((f) => `${f.title} (${f.severity})`).join("; ")}`, { size: 8.5, color: C.muted });
    }
  }
  if (portfolio.length) {
    w.heading("Relevant published portfolio");
    for (const item of portfolio) {
      w.text(item.title, { font: w.bold, size: 10 });
      if (item.description) w.text(item.description, { size: 9, color: C.muted });
      w.text(item.projectUrl, { size: 8.5, color: accent, link: item.projectUrl });
    }
  }

  // ---- overview
  w.heading("Overview");
  const highish = (s.findingsBySeverity.critical ?? 0) + (s.findingsBySeverity.high ?? 0);
  w.text(`${s.totalFindings} findings (${highish} critical or high). ${s.linksChecked} link destinations checked, ${s.brokenLinks} confirmed broken${s.inconclusiveLinks ? `, ${s.inconclusiveLinks} could not be verified` : ""}.`);
  w.gap(6);
  w.heading("Scores", 2);
  w.text("Scores are calculated from this audit's findings with a documented formula. Categories that were not evaluated have no score.", { size: 8.5, color: C.muted });
  w.gap(2);
  const colW = [CONTENT_W * 0.5, CONTENT_W * 0.2, CONTENT_W * 0.3];
  w.row([{ text: "Category", width: colW[0], font: w.bold }, { text: "Score", width: colW[1], font: w.bold, align: "right" }, { text: "Findings", width: colW[2], font: w.bold, align: "right" }], { fill: C.soft });
  for (const c of CATEGORIES) {
    const v = s.scores[c];
    const evaluated = v !== null && v !== undefined;
    w.row([
      { text: CATEGORY_LABELS[c], width: colW[0] },
      { text: evaluated ? `${v} / 100` : "Not evaluated", width: colW[1], align: "right", color: !evaluated ? C.muted : v >= 90 ? C.good : v >= 70 ? C.warn : C.bad, font: evaluated ? w.bold : w.font },
      { text: String(s.findingsByCategory[c] ?? 0), width: colW[2], align: "right" },
    ]);
  }
  w.gap(8);
  w.heading("Findings by severity", 2);
  w.text(SEVERITIES.map((sev) => `${SEVERITY_LABELS[sev]}: ${s.findingsBySeverity[sev] ?? 0}`).join("    "));

  // ---- coverage
  w.heading("Coverage");
  const label = { done: "Evaluated", partial: "Partial", skipped: "Not evaluated" } as const;
  for (const r of coverageRows({ scan })) {
    w.row([
      { text: r.label, width: CONTENT_W * 0.27, font: w.bold },
      { text: label[r.state], width: CONTENT_W * 0.17, color: r.state === "done" ? C.good : r.state === "partial" ? C.warn : C.muted },
      { text: r.detail, width: CONTENT_W * 0.56, color: C.muted },
    ]);
  }

  // ---- action plan
  w.heading("Action plan");
  const top = priorityFindings(input.findings, 8);
  if (!top.length) w.text("No critical, high or medium issues were found.", { color: C.muted });
  top.forEach((f, i) => {
    w.ensure(40);
    w.text(`${i + 1}. ${f.title}`, { font: w.bold, size: 10.5 });
    w.text(`${SEVERITY_LABELS[f.severity]} | ${CATEGORY_LABELS[f.category]} | ${f.affectedCount} affected`, { size: 8.5, color: SEV_COLOR[f.severity], x: M.left + 12 });
    w.text(f.recommendation, { size: 9.5, x: M.left + 12, color: C.text });
    w.gap(4);
  });

  // ---- performance
  w.heading("Performance");
  if (!input.performance.length) {
    w.text(`Not evaluated${s.coverage?.performance.skippedReason ? `: ${clause(s.coverage.performance.skippedReason)}` : ""}. No performance values are shown or scored.`, { color: C.muted });
  }
  for (const run of input.performance) {
    w.heading(`${run.strategy === "mobile" ? "Mobile (emulated)" : "Desktop"} - start page`, 2);
    if (!run.ok) {
      w.text(`Not evaluated: ${run.error?.message ?? "the test did not complete."}`, { color: C.muted });
      continue;
    }
    w.text(`Lab data (Lighthouse ${run.lighthouseVersion ?? ""} via PageSpeed Insights, ${fmtDate(run.fetchedAt)}): one simulated page load.`, { size: 8.5, color: C.muted });
    const cw = CONTENT_W / 3;
    w.row([
      { text: `Score: ${run.score ?? "-"}`, width: cw, font: w.bold },
      { text: `LCP: ${fmtMs(run.lab.lcpMs)}`, width: cw },
      { text: `CLS: ${run.lab.cls === null ? "-" : run.lab.cls.toFixed(2)}`, width: cw },
    ]);
    w.row([
      { text: `TBT: ${fmtMs(run.lab.tbtMs)} (lab; not INP)`, width: cw },
      { text: `FCP: ${fmtMs(run.lab.fcpMs)}`, width: cw },
      { text: `Speed Index: ${fmtMs(run.lab.speedIndexMs)}`, width: cw },
    ]);
    if (run.field) {
      const f = run.field;
      const fm = (m: { p75: number; category: string | null } | null, cls = false) => (m ? `${cls ? m.p75.toFixed(2) : fmtMs(m.p75)}${m.category ? ` (${m.category.replace("_", " ")})` : ""}` : "no data");
      w.gap(2);
      w.text(`Field data (Chrome UX Report, ${f.scope === "origin" ? "whole-site" : "this URL"}, 75th percentile, 28 days): LCP ${fm(f.lcp)}, INP ${fm(f.inp)}, CLS ${fm(f.cls, true)}.`, { size: 9.5 });
    } else w.text("Field data: not available (too little real-user traffic). INP is only measured from real users, so it is not evaluated.", { size: 9.5, color: C.muted });
    if (run.opportunities.length) w.text(`Top opportunities: ${run.opportunities.slice(0, 4).map((o) => o.title + (o.displayValue ? ` (${o.displayValue})` : "")).join("; ")}.`, { size: 9, color: C.muted });
  }

  // ---- browser + accessibility
  w.heading("Rendering & accessibility");
  if (!input.renders.length) w.text(`Browser rendering not evaluated${s.coverage?.browser.skippedReason ? `: ${clause(s.coverage.browser.skippedReason)}` : ""}. Pages were audited from their HTML.`, { color: C.muted });
  else {
    const cw = [CONTENT_W * 0.44, CONTENT_W * 0.16, CONTENT_W * 0.12, CONTENT_W * 0.28];
    w.row([{ text: "Page", width: cw[0], font: w.bold }, { text: "Result", width: cw[1], font: w.bold }, { text: "JS errors", width: cw[2], font: w.bold }, { text: "Accessibility (axe-core)", width: cw[3], font: w.bold }], { fill: C.soft });
    for (const r of input.renders) {
      w.row([
        { text: r.url, width: cw[0], font: w.mono, size: 8 },
        { text: r.ok ? "Rendered" : (r.error?.code ?? "failed").replace(/_/g, " "), width: cw[1], color: r.ok ? C.good : C.warn },
        { text: r.ok ? String(r.consoleErrors) : "-", width: cw[2] },
        { text: r.axe ? (r.axe.violations ? `${r.axe.violations} rule(s), ${r.axe.affectedNodes} element(s)` : "No automated violations") : "Not tested", width: cw[3] },
      ]);
    }
  }
  w.gap(4);
  w.text(ACCESSIBILITY_DISCLAIMER, { size: 8.5, color: C.muted });

  // ---- issues
  const sorted = [...input.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.affectedCount - a.affectedCount);
  w.heading(`Issues (${sorted.length})`);
  if (!sorted.length) w.text("No issues were found.", { color: C.muted });
  sorted.forEach((f) => {
    w.ensure(70);
    w.gap(4);
    w.text(f.title, { font: w.bold, size: 10.5 });
    w.text(`${SEVERITY_LABELS[f.severity]} | ${CATEGORY_LABELS[f.category]} | ${f.type} | ${f.affectedCount} affected | rule ${f.ruleId}`, { size: 8, color: SEV_COLOR[f.severity] });
    w.text(f.description, { size: 9 });
    w.text(`Evidence: ${f.evidence.summary}`, { size: 9, color: C.muted });
    // Group identical values, not evidence content: all labels/values remain present.
    const evidence = new Map<string, string[]>();
    for (const item of f.evidence.items) evidence.set(item.value, [...(evidence.get(item.value) ?? []), item.label]);
    for (const [value, labels] of evidence) w.text(`- ${labels.join(", ")}: ${value}`, { size: 8, color: C.muted, x: M.left + 10, link: /^https?:\/\//i.test(value) ? value : undefined });
    const urls = [...new Set(f.affectedUrls)];
    if (urls.length) {
      w.text("Affected:", { size: 8, color: C.muted });
      for (const u of urls) w.text(u, { size: 7.5, font: w.mono, color: C.muted, x: M.left + 10, link: u });
      if (f.affectedCount > urls.length) w.text(`${f.affectedCount} occurrences across the affected URLs supplied by the audit`, { size: 8, color: C.muted, x: M.left + 10 });
    }
    w.text(`Fix: ${f.recommendation}`, { size: 9 });
    w.page.drawLine({ start: { x: M.left, y: w.y - 3 }, end: { x: A4.w - M.right, y: w.y - 3 }, thickness: 0.4, color: C.line });
    w.gap(6);
  });
  // ---- limitations
  w.heading("Limitations");
  const limits = [
    `This is an automated audit of up to ${scan.limits.maxPages} pages (depth ${scan.limits.maxDepth}) and ${scan.limits.maxLinksToCheck} link destinations. It respects robots.txt and does not log in or submit forms.`,
    scan.crawl.crawlTruncated ? `Not every discovered URL was crawled: ${scan.crawl.skipped.limit} beyond the page limit, ${scan.crawl.skipped.depth} beyond the depth limit, ${scan.crawl.skipped.robots} disallowed by robots.txt, ${scan.crawl.skipped.traps} filtered.` : null,
    "Findings describe what was observed during this audit. They are not a guarantee of search ranking, indexing or rich-result eligibility.",
    "Performance lab values vary between runs; field data comes from the Chrome UX Report when available.",
    ...scan.warnings.map((x) => `Audit warning: ${x}`),
  ].filter((x): x is string => !!x);
  for (const l of limits) w.text(`- ${l}`, { size: 9, color: C.muted });

  // ---- footers
  const total = w.pages.length;
  w.pages.forEach((p, i) => {
    const footer = pdfText(`TalhaImtiazWorks  |  ${host}  |  ${fmtDate(generatedAt)}`);
    p.drawText(footer.length > 86 ? `${footer.slice(0, 83)}...` : footer, { x: M.left, y: 30, size: 7.5, font: w.font, color: C.muted });
    p.drawText(brandCopyright(generatedAt.getUTCFullYear()), { x: M.left, y: 18, size: 6.5, font: w.font, color: C.muted });
    const pn = `Page ${i + 1} of ${total}`;
    p.drawText(pn, { x: A4.w - M.right - w.font.widthOfTextAtSize(pn, 7.5), y: 30, size: 7.5, font: w.font, color: C.muted });
  });

  // Complete structured data travels with the PDF as well; no server-only fields are in this input.
  await doc.attach(Buffer.from(JSON.stringify(input, null, 2)), "audit-data.json", { mimeType: "application/json", description: "Complete audit findings, evidence, metadata and coverage used to generate this report.", creationDate: generatedAt, modificationDate: generatedAt });
  return doc.save({ useObjectStreams: true });
}
