/**
 * Minimal PDF text extraction for tests. Decodes each page's content stream,
 * tracks the active font (Tf) and maps hex strings through that font's
 * ToUnicode CMap (embedded TrueType fonts, 2-byte glyph IDs) or WinAnsi
 * (standard fonts). One output line per text-showing operator.
 */
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, type PDFObject } from "pdf-lib";

const WIN_ANSI: Record<number, string> = { 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x85: "…", 0x80: "€" };

function streamText(stream: PDFRawStream): string {
  const bytes = Buffer.from(stream.contents);
  const filter = stream.dict.get(PDFName.of("Filter"));
  if (filter && String(filter).includes("FlateDecode")) return inflateSync(bytes).toString("latin1");
  return bytes.toString("latin1");
}

function hexToString(hex: string): string {
  const out: number[] = [];
  for (let i = 0; i + 4 <= hex.length; i += 4) out.push(parseInt(hex.slice(i, i + 4), 16));
  return String.fromCodePoint(...out);
}

function parseCMap(src: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(m[1], 16), decodeUtf16(m[2]));
  }
  for (const block of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (m[4]) {
        const base = decodeUtf16(m[4]);
        const start = base.codePointAt(0)!;
        for (let g = lo; g <= hi; g++) map.set(g, String.fromCodePoint(start + (g - lo)));
      } else {
        const items = [...m[5].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => decodeUtf16(x[1]));
        items.forEach((v, i) => map.set(lo + i, v));
      }
    }
  }
  return map;
}

function decodeUtf16(hex: string): string {
  const units: number[] = [];
  for (let i = 0; i + 4 <= hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
  return String.fromCharCode(...units);
}

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const ctx = doc.context;
  const lookup = (o: PDFObject | undefined) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const lines: string[] = [];
  for (const page of doc.getPages()) {
    const fonts = new Map<string, { cmap: Map<number, string> | null }>();
    const res = lookup(page.node.get(PDFName.of("Resources"))) as PDFDict | undefined;
    const fontDict = res ? (lookup(res.get(PDFName.of("Font"))) as PDFDict | undefined) : undefined;
    for (const [name, ref] of fontDict?.entries() ?? []) {
      const font = lookup(ref) as PDFDict;
      const tu = lookup(font.get(PDFName.of("ToUnicode")));
      fonts.set(name.asString().slice(1), { cmap: tu instanceof PDFRawStream ? parseCMap(streamText(tu)) : null });
    }
    const contents = lookup(page.node.get(PDFName.of("Contents")));
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => lookup(r)) : [contents];
    const src = streams.filter((s): s is PDFRawStream => s instanceof PDFRawStream).map(streamText).join("\n");
    let current: { cmap: Map<number, string> | null } | null = null;
    for (const m of src.matchAll(/\/([^\s/]+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]*)>\s*Tj/g)) {
      if (m[1]) {
        current = fonts.get(m[1]) ?? null;
        continue;
      }
      const hex = m[2];
      if (current?.cmap) {
        let s = "";
        for (let i = 0; i + 4 <= hex.length; i += 4) s += current.cmap.get(parseInt(hex.slice(i, i + 4), 16)) ?? "\uFFFD";
        lines.push(s);
      } else {
        lines.push([...Buffer.from(hex, "hex")].map((c) => WIN_ANSI[c] ?? String.fromCharCode(c)).join(""));
      }
    }
  }
  return lines.join("\n");
}

export { hexToString };
