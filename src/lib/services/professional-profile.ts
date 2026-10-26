import "server-only";
import { z } from "zod";
import { CATEGORIES, type Finding, type FindingCategory } from "../audit/types";
import type { AccountRepository } from "../db/account-types";
import { ApiError } from "../http/api";
import { decodeLogoDataUrl } from "../professional/logo";
import { fullyDecodeLogoDataUrl } from "../professional/logo-validation";
import { MAX_LOGO_DATA_URL_CHARS } from "../professional/logo-limits";
import { normalizeHexColor, normalizeStoredBrandColors } from "../professional/brand-colors";
import { opportunityScore } from "../leads/opportunity";
import { validatePublicUrl } from "../security/url";
import { PROFESSIONAL_PROFILE_TYPES, PUBLIC_PROFILE_FIELDS, type MatchedProfessionalService, type ProfessionalData, type ProfessionalPortfolioItem, type ProfessionalProfile, type ProfessionalService, type PublishedPortfolioItem, type PublishedProfessionalProfile } from "../professional/types";

const clean = (value: string, max: number) => value
  .replace(/\r\n?/g, "\n")
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "")
  .trim()
  .slice(0, max);
const textField = (max: number) => z.string().max(max).transform((v) => clean(v, max));
const uniqueList = <T extends string>(items: T[]) => new Set(items).size === items.length;

function isHttpUrl(value: string): boolean {
  if (!value) return true;
  return validatePublicUrl(value, { allowedPorts: [80, 443], assumeHttps: false }).ok;
}

const profileUrl = z.string().trim().max(2048).refine(isHttpUrl, "Enter a full http(s) URL without a username or password.");
const projectUrl = z.string().trim().min(1).max(2048).refine(isHttpUrl, "Enter a full http(s) URL without a username or password.");
const categories = z.array(z.enum(CATEGORIES)).max(CATEGORIES.length).refine(uniqueList, "Choose each category only once.");
const namedColor = z.object({
  name: z.string().trim().max(40, "Use a color name of 40 characters or fewer.").transform((value) => clean(value, 40)).refine(Boolean, "Enter a name for this color."),
  value: z.string().trim().regex(/^#?[\da-fA-F]{6}$/, "Use a six-digit hex color, with or without #.").transform((value) => normalizeHexColor(value)!),
}).strict();
const legacyColor = z.string().trim().regex(/^#?[\da-fA-F]{6}$/, "Use a six-digit hex color, with or without #.")
  .transform((value) => ({ name: "", value: normalizeHexColor(value)! }));
const colorPalette = z.array(z.union([namedColor, legacyColor])).max(10, "Use at most 10 brand colors.")
  .transform((colors) => colors.map((color, index) => ({ ...color, name: color.name || `Brand color ${index + 1}` })))
  .refine((colors) => new Set(colors.map((color) => color.value)).size === colors.length, "Brand color values must be distinct.");

function validLogoDataUrl(value: string | null): boolean {
  return value === null || decodeLogoDataUrl(value) !== null;
}

const profileSchema = z.object({
  profileType: z.enum(PROFESSIONAL_PROFILE_TYPES),
  professionalName: textField(100),
  businessName: textField(120),
  jobTitle: textField(100),
  headline: textField(180),
  biography: textField(2000),
  websiteUrl: profileUrl,
  contactEmail: z.string().trim().max(254).refine((v) => !v || z.email().safeParse(v).success, "Enter a valid email address."),
  contactPhone: textField(50),
  location: textField(120),
  publicFields: z.array(z.enum(PUBLIC_PROFILE_FIELDS)).max(PUBLIC_PROFILE_FIELDS.length).refine(uniqueList, "Publication fields must be unique."),
  brandColors: colorPalette,
  logoDataUrl: z.string().max(MAX_LOGO_DATA_URL_CHARS).nullable().refine(validLogoDataUrl, "Upload a PNG or JPEG logo at most 1 MiB (1,048,576 bytes). SVG and other image formats are not accepted."),
  // Read-only response fields are accepted on round-trip but recalculated/ignored on the server.
  onboardingCompleted: z.boolean().optional(),
  updatedAt: z.string().nullable().optional(),
}).strict();

const serviceSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1).max(100).transform((v) => clean(v, 100)),
  description: textField(1500),
  categories,
  keywords: z.array(z.string().trim().min(1).max(40).transform((v) => clean(v, 40))).max(10).refine((xs) => uniqueList(xs.map((x) => x.toLowerCase())), "Service keywords must be unique."),
  isPublic: z.boolean(),
  sortOrder: z.number().int().min(0).max(49).optional(),
}).strict();

const portfolioSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1).max(120).transform((v) => clean(v, 120)),
  projectUrl,
  description: textField(1200),
  serviceIds: z.array(z.uuid()).max(20).refine(uniqueList, "Portfolio service links must be unique."),
  categories,
  isPublic: z.boolean(),
  sortOrder: z.number().int().min(0).max(49).optional(),
}).strict();

export const professionalDataSchema = z.object({
  profile: profileSchema,
  services: z.array(serviceSchema).max(20),
  portfolio: z.array(portfolioSchema).max(25),
}).strict();

export function emptyProfessionalData(): ProfessionalData {
  const profile: ProfessionalProfile = { profileType: "freelancer", professionalName: "", businessName: "", jobTitle: "", headline: "", biography: "", websiteUrl: "", contactEmail: "", contactPhone: "", location: "", publicFields: [], brandColors: [], logoDataUrl: null, onboardingCompleted: false, updatedAt: null };
  return { profile, services: [], portfolio: [] };
}

export async function loadProfessionalData(accounts: AccountRepository, userId: string): Promise<ProfessionalData> {
  const data = await accounts.getProfessionalData(userId);
  return { ...data, profile: { ...data.profile, brandColors: normalizeStoredBrandColors(data.profile.brandColors) } };
}

export async function saveProfessionalData(accounts: AccountRepository, userId: string, raw: unknown): Promise<ProfessionalData> {
  const parsed = professionalDataSchema.parse(raw);
  if (parsed.profile.logoDataUrl && !(await fullyDecodeLogoDataUrl(parsed.profile.logoDataUrl))) {
    throw new ApiError(400, "invalid_logo", "The logo could not be fully decoded. Upload a valid PNG or JPEG at most 1 MiB.");
  }
  const serviceIds = new Set(parsed.services.map((s) => s.id));
  if (new Set(parsed.services.map((s) => s.id)).size !== parsed.services.length) {
    throw new ApiError(400, "duplicate_service", "Each service needs a unique ID.");
  }
  if (new Set(parsed.portfolio.map((p) => p.id)).size !== parsed.portfolio.length) {
    throw new ApiError(400, "duplicate_portfolio_item", "Each portfolio item needs a unique ID.");
  }
  if (parsed.portfolio.some((p) => p.serviceIds.some((id) => !serviceIds.has(id)))) {
    throw new ApiError(400, "invalid_portfolio_service", "A portfolio item can only link to a service in this profile.");
  }
  const profile = {
    ...parsed.profile,
    onboardingCompleted: Boolean(
      parsed.profile.professionalName && parsed.profile.headline &&
      (parsed.profile.profileType !== "agency" || parsed.profile.businessName),
    ),
    updatedAt: null,
  };
  const services: ProfessionalService[] = parsed.services.map((s, sortOrder) => ({ ...s, sortOrder }));
  const portfolio: ProfessionalPortfolioItem[] = parsed.portfolio.map((p, sortOrder) => ({ ...p, sortOrder }));
  return accounts.saveProfessionalData(userId, { profile, services, portfolio });
}

const normalizedMatchText = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Stable category/keyword matching against open, non-observation scanner findings.
 * No AI or free-form summary is used; every returned match carries its audit evidence.
 */
export function matchProfessionalServices(services: ProfessionalService[], findings: Finding[]): MatchedProfessionalService[] {
  // Normalize the potentially large evidence text once per finding, not once
  // for every service × finding pair when building a report snapshot.
  const preparedServices = services.map((service) => ({ service, keys: service.keywords.map(normalizedMatchText).filter(Boolean) }));
  const hasKeywords = preparedServices.some(({ keys }) => keys.length > 0);
  const eligible = findings
    .filter((f) => f.type !== "observation" && f.resolution?.status !== "ignored" && f.resolution?.status !== "resolved")
    .map((finding) => ({
      finding,
      text: hasKeywords ? ` ${normalizedMatchText([finding.ruleId, finding.title, finding.evidence.summary, ...finding.evidence.items.map((i) => `${i.label} ${i.value}`)].join(" "))} ` : "",
    }));
  const rows = preparedServices.map(({ service, keys }) => {
    const hits = eligible.filter(({ finding, text }) => {
      if (service.categories.includes(finding.category)) return true;
      if (!keys.length) return false;
      return keys.some((key) => text.includes(` ${key} `));
    }).map(({ finding }) => {
      const categoryHit = service.categories.includes(finding.category);
      const score = opportunityScore(finding) * (categoryHit ? 1 : 0.75);
      return { finding, score };
    }).sort((a, b) => b.score - a.score || a.finding.id.localeCompare(b.finding.id));
    const score = Math.round(hits.reduce((sum, hit) => sum + hit.score, 0) * 10) / 10;
    return { service, hits, score };
  }).filter((row) => row.hits.length > 0);

  return rows.sort((a, b) => b.score - a.score || a.service.sortOrder - b.service.sortOrder || a.service.title.localeCompare(b.service.title) || a.service.id.localeCompare(b.service.id))
    .map(({ service, hits, score }) => ({
      serviceId: service.id,
      title: service.title,
      description: service.description,
      categories: service.categories,
      score,
      matchedFindings: hits.slice(0, 5).map(({ finding }) => ({ id: finding.id, title: finding.title, ruleId: finding.ruleId, category: finding.category, severity: finding.severity, affectedCount: finding.affectedCount })),
    }));
}

export function buildPublishedProfessionalProfile(data: ProfessionalData): PublishedProfessionalProfile | null {
  const p = data.profile;
  const enabled = new Set(p.publicFields);
  const out: PublishedProfessionalProfile = {};
  if (enabled.has("profileType")) out.profileType = p.profileType;
  const copy = (key: keyof PublishedProfessionalProfile, field: keyof typeof p) => {
    const value = p[field];
    if (enabled.has(field as (typeof PUBLIC_PROFILE_FIELDS)[number]) && typeof value === "string" && value) (out as unknown as Record<string, unknown>)[key] = value;
  };
  copy("professionalName", "professionalName");
  if (p.profileType === "agency") copy("businessName", "businessName");
  copy("jobTitle", "jobTitle");
  copy("headline", "headline");
  copy("biography", "biography");
  copy("websiteUrl", "websiteUrl");
  copy("contactEmail", "contactEmail");
  copy("contactPhone", "contactPhone");
  copy("location", "location");
  if (enabled.has("brandColors") && p.brandColors.length) out.brandColors = p.brandColors.slice(0, 10).map((color) => color.value);
  if (enabled.has("logo") && p.logoDataUrl) out.logoDataUrl = p.logoDataUrl;
  return Object.keys(out).length ? out : null;
}

export function buildReportPersonalization(data: ProfessionalData, findings: Finding[]) {
  const publicServices = data.services.filter((s) => s.isPublic);
  const matchedServices = matchProfessionalServices(publicServices, findings);
  const matchedIds = new Set(matchedServices.map((s) => s.serviceId));
  const matchedCategories = new Set<FindingCategory>(matchedServices.flatMap((s) => s.matchedFindings.map((f) => f.category)));
  const portfolio: PublishedPortfolioItem[] = data.portfolio
    .filter((p) => p.isPublic && (p.serviceIds.some((id) => matchedIds.has(id)) || p.categories.some((c) => matchedCategories.has(c))))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    .map((p) => ({ id: p.id, title: p.title, projectUrl: p.projectUrl, description: p.description, serviceIds: p.serviceIds.filter((id) => matchedIds.has(id)), categories: p.categories.filter((c) => matchedCategories.has(c)) }));
  return { professional: buildPublishedProfessionalProfile(data), matchedServices, portfolio };
}
