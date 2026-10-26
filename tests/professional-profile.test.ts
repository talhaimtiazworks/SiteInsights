import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Finding } from "@/lib/audit/types";
import { decodeLogoDataUrl } from "@/lib/professional/logo";
import { MAX_LOGO_BYTES, MAX_LOGO_DATA_URL_CHARS } from "@/lib/professional/logo-limits";
import type { ProfessionalData, ProfessionalService } from "@/lib/professional/types";
import { buildPublishedProfessionalProfile, buildReportPersonalization, emptyProfessionalData, matchProfessionalServices, professionalDataSchema, saveProfessionalData } from "@/lib/services/professional-profile";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: randomUUID(), scanId: randomUUID(), ruleId: "seo:title-missing", category: "seo", type: "error", title: "Missing page title", severity: "high",
    description: "The page has no title.", affectedUrl: "https://example.test/", affectedUrls: ["https://example.test/"], affectedCount: 2,
    evidence: { summary: "The document title element is empty.", items: [{ label: "Title", value: "" }], urls: [] },
    detectionMethod: "HTML inspection", recommendation: "Add a descriptive title.", aiExplanationAvailable: false, createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function service(title: string, categories: ProfessionalService["categories"], sortOrder: number, keywords: string[] = []): ProfessionalService {
  return { id: randomUUID(), title, description: `${title} description`, categories, keywords, isPublic: true, sortOrder };
}

function pngDataUrl(width: number, height: number, size = 24) {
  const bytes = Buffer.alloc(size);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

describe("professional-profile publication and evidence matching", () => {
  it("publishes no profile fields by default and includes only fields explicitly selected", () => {
    const data = emptyProfessionalData();
    data.profile.professionalName = "Ayesha Example";
    data.profile.contactEmail = "hello@example.test";
    data.profile.brandColors = [{ name: "Primary", value: "#123456" }];
    expect(buildPublishedProfessionalProfile(data)).toBeNull();

    data.profile.publicFields = ["professionalName", "brandColors"];
    expect(buildPublishedProfessionalProfile(data)).toEqual({ professionalName: "Ayesha Example", brandColors: ["#123456"] });
    data.profile.publicFields.push("profileType");
    expect(buildPublishedProfessionalProfile(data)).toEqual({ profileType: "freelancer", professionalName: "Ayesha Example", brandColors: ["#123456"] });
  });

  it("embeds logo bytes into published report data only when the logo publication option is selected", () => {
    const data = emptyProfessionalData();
    data.profile.professionalName = "Mina Example";
    data.profile.logoDataUrl = "data:image/png;base64,AAAA";
    data.profile.publicFields = ["professionalName"];
    expect(buildPublishedProfessionalProfile(data)).toEqual({ professionalName: "Mina Example" });
    data.profile.publicFields.push("logo");
    expect(buildPublishedProfessionalProfile(data)).toEqual({ professionalName: "Mina Example", logoDataUrl: "data:image/png;base64,AAAA" });
  });

  it("preserves agency-only values across an explicit freelancer switch without publishing them", async () => {
    const data = emptyProfessionalData();
    data.profile.profileType = "agency";
    data.profile.professionalName = "Nadia Example";
    data.profile.headline = "Accessible web design";
    data.profile.businessName = "Northstar Studio";
    data.profile.publicFields = ["businessName"];
    // Switching profile type changes only the selected type; hidden data stays saved.
    data.profile.profileType = "freelancer";
    const accounts = {
      saveProfessionalData: async (_userId: string, next: ProfessionalData) => next,
    } as unknown as Parameters<typeof saveProfessionalData>[0];
    const result = await saveProfessionalData(accounts, randomUUID(), data);
    expect(result.profile.businessName).toBe("Northstar Studio");
    expect(result.profile.publicFields).toContain("businessName");
    expect(result.profile.profileType).toBe("freelancer");
    expect(buildPublishedProfessionalProfile(result)).toBeNull();
  });

  it("matches deterministically to open, verified categories or exact normalized keywords", () => {
    const seo = finding({ title: "Missing page title", category: "seo", ruleId: "seo:title-missing" });
    const links = finding({ title: "Broken internal links", category: "links", ruleId: "links:internal-broken", severity: "critical", affectedCount: 5 });
    const resolved = finding({ title: "Resolved issue", resolution: { status: "resolved", resolvedAt: "2026-01-02T00:00:00.000Z", note: null } });
    const ignored = finding({ title: "Ignored issue", resolution: { status: "ignored", resolvedAt: null, note: null } });
    const observation = finding({ title: "Informational note", type: "observation" });
    const services = [
      service("SEO service", ["seo"], 1),
      service("Link repair", ["links"], 2),
      service("Title optimization", [], 0, ["page title"]),
    ];
    const result = matchProfessionalServices(services, [seo, links, resolved, ignored, observation]);
    expect(result.map((x) => x.title)).toEqual(["Link repair", "SEO service", "Title optimization"]);
    expect(result[0].matchedFindings.map((f) => f.id)).toEqual([links.id]);
    expect(result[2].matchedFindings.map((f) => f.id)).toEqual([seo.id]);
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it("includes only public services and portfolio tied to actually matched evidence", () => {
    const data: ProfessionalData = emptyProfessionalData();
    const open = finding({ category: "performance", title: "Large image slows loading" });
    const relevantService = service("Performance optimization", ["performance"], 0);
    const privateService = { ...service("Private service", ["performance"], 1), isPublic: false };
    data.services = [relevantService, privateService];
    const linked: ProfessionalData["portfolio"][number] = { id: randomUUID(), title: "Relevant work", projectUrl: "https://portfolio.example.test/work", description: "Performance project", serviceIds: [relevantService.id], categories: [], isPublic: true, sortOrder: 0 };
    const unrelated: ProfessionalData["portfolio"][number] = { ...linked, id: randomUUID(), title: "Unrelated work", serviceIds: [], categories: ["seo"], sortOrder: 1 };
    data.portfolio = [linked, unrelated];
    const result = buildReportPersonalization(data, [open]);
    expect(result.matchedServices.map((x) => x.serviceId)).toEqual([relevantService.id]);
    expect(result.portfolio.map((x) => x.title)).toEqual(["Relevant work"]);
  });

  it("rejects duplicate/invalid brand colors, unsafe project URLs and SVG logos; accepts at most ten colors", () => {
    const base = { profile: { ...emptyProfessionalData().profile }, services: [], portfolio: [] };
    const tenColors = ["#010101", "#020202", "#030303", "#040404", "#050505", "#060606", "#070707", "#080808", "#090909", "#0A0A0A"];
    expect(professionalDataSchema.safeParse({ ...base, profile: { ...base.profile, brandColors: tenColors } }).success).toBe(true);
    expect(professionalDataSchema.safeParse({ ...base, profile: { ...base.profile, brandColors: ["#abcdef", "#ABCDEF"] } }).success).toBe(false);
    expect(professionalDataSchema.safeParse({ ...base, portfolio: [{ id: randomUUID(), title: "Unsafe", projectUrl: "javascript:alert(1)", description: "", serviceIds: [], categories: [], isPublic: true }] }).success).toBe(false);
    expect(professionalDataSchema.safeParse({ ...base, profile: { ...base.profile, logoDataUrl: "data:image/svg+xml;base64,PHN2Zy8+" } }).success).toBe(false);
  });

  it("enforces the exact 1 MiB raw-logo cap and derived data-URI bound", () => {
    const max = pngDataUrl(512, 512, MAX_LOGO_BYTES);
    const tooLarge = pngDataUrl(512, 512, MAX_LOGO_BYTES + 1);
    expect(MAX_LOGO_BYTES).toBe(1_048_576);
    expect(MAX_LOGO_DATA_URL_CHARS).toBe(1_398_127);
    expect(max.length).toBeLessThanOrEqual(MAX_LOGO_DATA_URL_CHARS);
    expect(decodeLogoDataUrl(max)?.bytes.byteLength).toBe(MAX_LOGO_BYTES);
    expect(decodeLogoDataUrl(tooLarge)).toBeNull();
  });

  it("rejects a header-only logo before persistence", async () => {
    const data = emptyProfessionalData();
    data.profile.logoDataUrl = pngDataUrl(2, 2);
    const accounts = { saveProfessionalData: async (_userId: string, next: ProfessionalData) => next } as unknown as Parameters<typeof saveProfessionalData>[0];
    await expect(saveProfessionalData(accounts, randomUUID(), data)).rejects.toThrow("could not be fully decoded");
  });

  it("bounds the data URI, checks its actual image signature/dimensions, and rejects spoofed or oversized images", () => {
    expect(decodeLogoDataUrl(pngDataUrl(512, 512))?.width).toBe(512);
    expect(decodeLogoDataUrl(pngDataUrl(2048, 976))?.width).toBe(2048);
    expect(decodeLogoDataUrl(pngDataUrl(2049, 1))).toBeNull();
    expect(decodeLogoDataUrl(pngDataUrl(2048, 977))).toBeNull();
    expect(decodeLogoDataUrl(pngDataUrl(20_000, 20_000))).toBeNull();
    expect(decodeLogoDataUrl(`data:image/png;base64,${"A".repeat(MAX_LOGO_DATA_URL_CHARS)}`)).toBeNull();
    expect(decodeLogoDataUrl(`data:image/jpeg;base64,${Buffer.alloc(24).toString("base64")}`)).toBeNull();
  });
});
