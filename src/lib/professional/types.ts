import type { FindingCategory, Severity } from "../audit/types";

export const PROFESSIONAL_PROFILE_TYPES = ["freelancer", "agency"] as const;
export type ProfessionalProfileType = (typeof PROFESSIONAL_PROFILE_TYPES)[number];

export interface BrandColor {
  name: string;
  /** Canonical six-digit hex, including # and uppercase digits. */
  value: string;
}

/** Every report-visible field is opt-in. An empty list is private by default. */
export const PUBLIC_PROFILE_FIELDS = [
  "profileType",
  "professionalName",
  "businessName",
  "jobTitle",
  "headline",
  "biography",
  "websiteUrl",
  "contactEmail",
  "contactPhone",
  "location",
  "brandColors",
  "logo",
] as const;
export type PublicProfileField = (typeof PUBLIC_PROFILE_FIELDS)[number];

export interface ProfessionalProfile {
  profileType: ProfessionalProfileType;
  professionalName: string;
  businessName: string;
  jobTitle: string;
  headline: string;
  biography: string;
  websiteUrl: string;
  contactEmail: string;
  contactPhone: string;
  location: string;
  publicFields: PublicProfileField[];
  brandColors: BrandColor[];
  logoDataUrl: string | null;
  onboardingCompleted: boolean;
  updatedAt: string | null;
}

export interface ProfessionalService {
  id: string;
  title: string;
  description: string;
  /** Audit categories this service can address. Matching is exact and deterministic. */
  categories: FindingCategory[];
  /** Optional phrases, matched only against verified finding titles/rule IDs/evidence. */
  keywords: string[];
  isPublic: boolean;
  sortOrder: number;
}

export interface ProfessionalPortfolioItem {
  id: string;
  title: string;
  projectUrl: string;
  description: string;
  serviceIds: string[];
  categories: FindingCategory[];
  isPublic: boolean;
  sortOrder: number;
}

export interface ProfessionalData {
  profile: ProfessionalProfile;
  services: ProfessionalService[];
  portfolio: ProfessionalPortfolioItem[];
}

export type ProfessionalDataInput = Pick<ProfessionalData, "profile" | "services" | "portfolio">;

export interface PublishedProfessionalProfile {
  profileType?: ProfessionalProfileType;
  professionalName?: string;
  businessName?: string;
  jobTitle?: string;
  headline?: string;
  biography?: string;
  websiteUrl?: string;
  contactEmail?: string;
  contactPhone?: string;
  location?: string;
  brandColors?: string[];
  logoDataUrl?: string;
}

export interface MatchedFinding {
  id: string;
  title: string;
  ruleId: string;
  category: FindingCategory;
  severity: Severity;
  affectedCount: number;
}

export interface MatchedProfessionalService {
  serviceId: string;
  title: string;
  description: string;
  categories: FindingCategory[];
  score: number;
  matchedFindings: MatchedFinding[];
}

export interface PublishedPortfolioItem {
  id: string;
  title: string;
  projectUrl: string;
  description: string;
  serviceIds: string[];
  categories: FindingCategory[];
}
