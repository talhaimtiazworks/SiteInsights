export interface ImportedProspectRow {
  row: number;
  website: string;
  businessName: string | null;
  location: string | null;
}

/** Small, strict RFC 4180-style parser for owner-supplied prospect CSV files (no provider or scraping). */
export function parseProspectCsv(input: string, maxRows = 100): ImportedProspectRow[] {
  if (input.length > 100_000) throw new Error("CSV is too large (maximum 100 KB).");
  const csv = input.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;

  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"') {
        if (csv[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; afterQuote = true; }
      } else field += ch;
      continue;
    }
    if (afterQuote && ch !== "," && ch !== "\r" && ch !== "\n" && ch !== " " && ch !== "\t") throw new Error("CSV contains unexpected text after a quoted field.");
    if (ch === '"') {
      if (field.length || afterQuote) throw new Error("CSV contains a quote in an unquoted field.");
      quoted = true;
    } else if (ch === ",") {
      row.push(field.trim()); field = ""; afterQuote = false;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && csv[i + 1] === "\n") i++;
      row.push(field.trim()); field = ""; afterQuote = false;
      if (row.some((v) => v.length)) records.push(row);
      row = [];
      if (records.length > maxRows + 1) throw new Error(`CSV can contain up to ${maxRows} prospect rows.`);
    } else {
      if (afterQuote && (ch === " " || ch === "\t")) continue;
      field += ch;
    }
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  if (field.length || row.length) {
    row.push(field.trim());
    if (row.some((v) => v.length)) records.push(row);
  }
  if (records.length < 2) throw new Error("CSV needs a header and at least one prospect row.");
  if (records.length - 1 > maxRows) throw new Error(`CSV can contain up to ${maxRows} prospect rows.`);

  const headers = records[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  const websiteIndex = headers.findIndex((h) => ["website", "website_url", "url"].includes(h));
  if (websiteIndex < 0) throw new Error("CSV must include a Website or URL column.");
  const nameIndex = headers.findIndex((h) => ["business_name", "business", "name"].includes(h));
  const locationIndex = headers.findIndex((h) => h === "location");
  return records.slice(1).map((r, i) => ({
    row: i + 2,
    website: r[websiteIndex] ?? "",
    businessName: nameIndex < 0 ? null : (r[nameIndex]?.slice(0, 160) || null),
    location: locationIndex < 0 ? null : (r[locationIndex]?.slice(0, 160) || null),
  }));
}
