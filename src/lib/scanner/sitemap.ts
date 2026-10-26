import zlib from "node:zlib";

export interface ParsedSitemap {
  type: "urlset" | "index" | "invalid";
  locs: string[];
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

/** Parses sitemap XML (urlset or sitemapindex). Bounded by maxLocs. */
export function parseSitemap(xml: string, maxLocs: number): ParsedSitemap {
  const head = xml.slice(0, 5000).toLowerCase();
  const isIndex = /<sitemapindex[\s>]/.test(head);
  const isUrlset = /<urlset[\s>]/.test(head);
  if (!isIndex && !isUrlset) return { type: "invalid", locs: [] };
  const locs: string[] = [];
  const re = /<loc>([\s\S]*?)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && locs.length < maxLocs) {
    const v = decodeXmlEntities(m[1]);
    if (v) locs.push(v);
  }
  return { type: isIndex ? "index" : "urlset", locs };
}

/** Gunzips a body if it is gzip-compressed (e.g. sitemap.xml.gz), bounded. */
export function maybeGunzip(body: Buffer, maxBytes: number): Buffer {
  if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
    try {
      return zlib.gunzipSync(body, { maxOutputLength: maxBytes });
    } catch {
      return Buffer.alloc(0);
    }
  }
  return body;
}
