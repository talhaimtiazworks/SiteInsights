import { describe, expect, it, vi } from "vitest";
import { addBrandColor, brandColorIssues, normalizeHexColor, normalizeStoredBrandColors, removeBrandColor, updateBrandColor } from "@/lib/professional/brand-colors";
import { buildPublishedProfessionalProfile, emptyProfessionalData, professionalDataSchema, saveProfessionalData } from "@/lib/services/professional-profile";
import type { ProfessionalData } from "@/lib/professional/types";

const userId = "11111111-2222-4333-8444-555555555555";
const inputWithColors = (brandColors: unknown[]) => {
  const data = emptyProfessionalData();
  return { ...data, profile: { ...data.profile, brandColors } };
};

describe("named brand color management", () => {
  it("normalizes hex input with or without # to one uppercase, six-digit format", () => {
    expect(normalizeHexColor("1b1931")).toBe("#1B1931");
    expect(normalizeHexColor(" #f4b43b ")).toBe("#F4B43B");
    for (const invalid of ["#123", "12345", "#1234567", "red", "#GGGGGG", ""]) expect(normalizeHexColor(invalid)).toBeNull();
  });

  it("accepts and persists multiple named colors while keeping published snapshots value-only and opt-in", async () => {
    const raw = inputWithColors([
      { name: "Primary Purple", value: "1b1931" },
      { name: "Accent Gold", value: "#f4b43b" },
    ]);
    const parsed = professionalDataSchema.parse(raw);
    expect(parsed.profile.brandColors).toEqual([
      { name: "Primary Purple", value: "#1B1931" },
      { name: "Accent Gold", value: "#F4B43B" },
    ]);

    const saveProfessionalDataMock = vi.fn(async (_id: string, data: ProfessionalData) => structuredClone(data));
    const saved = await saveProfessionalData({ saveProfessionalData: saveProfessionalDataMock } as never, userId, raw);
    expect(saveProfessionalDataMock).toHaveBeenCalledExactlyOnceWith(userId, expect.objectContaining({ profile: expect.objectContaining({ brandColors: parsed.profile.brandColors }) }));
    expect(saved.profile.brandColors).toEqual(parsed.profile.brandColors);
    expect(buildPublishedProfessionalProfile(saved)).toBeNull();
    saved.profile.publicFields = ["brandColors"];
    expect(buildPublishedProfessionalProfile(saved)).toEqual({ brandColors: ["#1B1931", "#F4B43B"] });
  });

  it("converts existing string palettes to named values without losing colors", () => {
    expect(normalizeStoredBrandColors(["#abcdef", "F4B43B", { name: "Brand ink", value: "1b1931" }])).toEqual([
      { name: "Brand color 1", value: "#ABCDEF" },
      { name: "Brand color 2", value: "#F4B43B" },
      { name: "Brand ink", value: "#1B1931" },
    ]);
    expect(professionalDataSchema.parse(inputWithColors(["#abcdef"])).profile.brandColors).toEqual([{ name: "Brand color 1", value: "#ABCDEF" }]);
  });

  it("rejects invalid, duplicate and over-limit color values and requires names", () => {
    expect(professionalDataSchema.safeParse(inputWithColors([{ name: "Primary", value: "#123" }])).success).toBe(false);
    expect(professionalDataSchema.safeParse(inputWithColors([{ name: "", value: "#123456" }])).success).toBe(false);
    expect(professionalDataSchema.safeParse(inputWithColors([{ name: "Primary", value: "#abcdef" }, { name: "Accent", value: "ABCDEF" }])).success).toBe(false);
    const elevenColors = Array.from({ length: 11 }, (_, i) => ({ name: `Color ${i}`, value: `#${i.toString(16).padStart(6, "0")}` }));
    expect(professionalDataSchema.safeParse(inputWithColors(elevenColors)).success).toBe(false);

    const issues = brandColorIssues([{ name: " ", value: "#123" }]);
    expect(issues[0]).toEqual({ name: "Enter a name for this color.", value: "Enter a valid six-digit hex color, with or without #." });
    const duplicates = [{ name: "Primary", value: "#abcdef" }, { name: "Accent", value: "ABCDEF" }];
    expect(brandColorIssues(duplicates)).toEqual([
      { value: "This hex value is already in the palette." },
      { value: "This hex value is already in the palette." },
    ]);
  });

  it("adds, edits and removes colors without duplicates and caps the palette at ten", () => {
    let colors = addBrandColor([]);
    expect(colors).toHaveLength(1);
    colors = updateBrandColor(colors, 0, { name: "Primary Purple", value: "1b1931" });
    colors = addBrandColor(colors);
    colors = updateBrandColor(colors, 1, { name: "Accent Gold", value: "#F4B43B" });
    expect(brandColorIssues(colors)).toEqual([{}, {}]);
    colors = removeBrandColor(colors, 0);
    expect(colors).toEqual([{ name: "Accent Gold", value: "#F4B43B" }]);
    colors = Array.from({ length: 10 }, (_, i) => ({ name: `Color ${i + 1}`, value: `#${(i + 1).toString(16).padStart(6, "0")}` }));
    expect(addBrandColor(colors)).toHaveLength(10);
  });
});
