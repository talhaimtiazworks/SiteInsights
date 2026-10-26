import type { BrandColor } from "./types";

const HEX_COLOR = /^#?([\da-fA-F]{6})$/;
const DEFAULT_COLORS = ["#1367A8", "#0E436B", "#F4B43B", "#1B1931", "#56636F", "#1D6B48", "#B8621B", "#C98A12", "#0A3454", "#E6EEF5"] as const;

export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = HEX_COLOR.exec(value.trim());
  return match ? `#${match[1].toUpperCase()}` : null;
}

/**
 * Converts pre-named string palettes from older profile records into named
 * entries without dropping a saved color. JSONB remains the account store.
 */
export function normalizeStoredBrandColors(value: unknown): BrandColor[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((entry, index) => {
    const legacy = typeof entry === "string";
    const record = typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : null;
    const normalized = normalizeHexColor(legacy ? entry : record?.value);
    if (!normalized) return [];
    const rawName = legacy ? "" : record?.name;
    const name = typeof rawName === "string" ? rawName.trim().replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "").slice(0, 40) : "";
    return [{ name: name || `Brand color ${index + 1}`, value: normalized }];
  });
}

export interface BrandColorIssue {
  name?: string;
  value?: string;
}

/** Per-row inline validation for the professional profile palette editor. */
export function brandColorIssues(colors: readonly BrandColor[]): BrandColorIssue[] {
  return colors.map((color, index) => {
    const issue: BrandColorIssue = {};
    const name = color.name.trim();
    const value = normalizeHexColor(color.value);
    if (!name) issue.name = "Enter a name for this color.";
    else if (name.length > 40) issue.name = "Use a color name of 40 characters or fewer.";
    if (!value) issue.value = "Enter a valid six-digit hex color, with or without #.";
    else if (colors.some((other, otherIndex) => otherIndex !== index && normalizeHexColor(other.value) === value)) {
      issue.value = "This hex value is already in the palette.";
    }
    return issue;
  });
}

export function addBrandColor(colors: readonly BrandColor[]): BrandColor[] {
  if (colors.length >= 10) return [...colors];
  const used = new Set(colors.map((color) => normalizeHexColor(color.value)).filter((value): value is string => value !== null));
  let value: string | undefined = DEFAULT_COLORS.find((candidate) => !used.has(candidate));
  if (!value) {
    for (let seed = 1; ; seed++) {
      const candidate = `#${seed.toString(16).padStart(6, "0").slice(-6).toUpperCase()}`;
      if (!used.has(candidate)) { value = candidate; break; }
    }
  }
  return [...colors, { name: `Brand color ${colors.length + 1}`, value: value! }];
}

export function updateBrandColor(colors: readonly BrandColor[], index: number, patch: Partial<BrandColor>): BrandColor[] {
  if (index < 0 || index >= colors.length) return [...colors];
  return colors.map((color, current) => current === index ? { ...color, ...patch } : color);
}

export function removeBrandColor(colors: readonly BrandColor[], index: number): BrandColor[] {
  return colors.filter((_, current) => current !== index);
}
