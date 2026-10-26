import { describe, expect, it } from "vitest";
import { parseProspectCsv } from "@/lib/leads/prospect-import";

describe("manual prospect CSV import", () => {
  it("accepts quoted RFC-4180-style fields and common URL/name headers", () => {
    expect(parseProspectCsv('\uFEFFWebsite,Business name,Location\r\nhttps://one.example.test,"Studio, One",Karachi\r\nhttps://two.example.test,Two,\"New York\"')).toEqual([
      { row: 2, website: "https://one.example.test", businessName: "Studio, One", location: "Karachi" },
      { row: 3, website: "https://two.example.test", businessName: "Two", location: "New York" },
    ]);
    expect(parseProspectCsv("url,name\nhttps://example.test,Example")[0]).toMatchObject({ website: "https://example.test", businessName: "Example" });
  });

  it("rejects missing headers, malformed quotes, and overlarge imports", () => {
    expect(() => parseProspectCsv("name,location\nExample,Karachi")).toThrow(/Website or URL column/i);
    expect(() => parseProspectCsv('website,name\nhttps://example.test,"unfinished')).toThrow(/unclosed quoted/i);
    expect(() => parseProspectCsv(`website\n${Array.from({ length: 3 }, (_, i) => `https://${i}.example.test`).join("\n")}`, 2)).toThrow(/up to 2 prospect rows/i);
  });
});
