import { NextRequest } from "next/server";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyProfessionalData } from "@/lib/services/professional-profile";
import type { ProfessionalData } from "@/lib/professional/types";

const mocks = vi.hoisted(() => ({ authPreflight: vi.fn(), requireAccount: vi.fn() }));
vi.mock("@/lib/auth/route-helpers", () => ({ authPreflight: mocks.authPreflight }));
vi.mock("@/lib/services/account", () => ({ requireAccount: mocks.requireAccount }));

import { GET, PUT } from "@/app/api/account/professional-profile/route";

const USER_ID = "11111111-2222-4333-8444-555555555555";
let persisted: ProfessionalData;
let accounts: {
  getProfessionalData: ReturnType<typeof vi.fn>;
  saveProfessionalData: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  persisted = emptyProfessionalData();
  accounts = {
    getProfessionalData: vi.fn(async () => structuredClone(persisted)),
    saveProfessionalData: vi.fn(async (_userId: string, next: ProfessionalData) => {
      persisted = structuredClone(next);
      return structuredClone(persisted);
    }),
  };
  mocks.authPreflight.mockImplementation(() => undefined);
  mocks.requireAccount.mockResolvedValue({ user: { id: USER_ID }, accounts });
});

describe("professional-profile logo persistence", () => {
  it("saves named colors with normalized values and returns them after a separate reload", async () => {
    const data = emptyProfessionalData();
    data.profile.brandColors = [
      { name: "Primary Purple", value: "1b1931" },
      { name: "Accent Gold", value: "#f4b43b" },
    ];
    const putRequest = new NextRequest("https://siteinsight.example/api/account/professional-profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    const saved = await PUT(putRequest, {} as never);
    expect(saved.status).toBe(200);
    expect((await saved.json()).data.professional.profile.brandColors).toEqual([
      { name: "Primary Purple", value: "#1B1931" },
      { name: "Accent Gold", value: "#F4B43B" },
    ]);

    const refresh = await GET(new NextRequest("https://siteinsight.example/api/account/professional-profile"), {} as never);
    expect(refresh.status).toBe(200);
    expect((await refresh.json()).data.professional.profile.brandColors).toEqual([
      { name: "Primary Purple", value: "#1B1931" },
      { name: "Accent Gold", value: "#F4B43B" },
    ]);
  });

  it("returns the saved PNG preview on a separate request, as after a refresh", async () => {
    const png = await sharp({ create: { width: 8, height: 6, channels: 4, background: { r: 14, g: 67, b: 107, alpha: 1 } } }).png().toBuffer();
    const logoDataUrl = `data:image/png;base64,${png.toString("base64")}`;
    const data = emptyProfessionalData();
    data.profile.professionalName = "Ayesha Example";
    data.profile.logoDataUrl = logoDataUrl;
    data.profile.publicFields = ["logo"];
    const putRequest = new NextRequest("https://siteinsight.example/api/account/professional-profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });

    const saved = await PUT(putRequest, {} as never);
    expect(saved.status).toBe(200);
    expect((await saved.json()).data.professional.profile.logoDataUrl).toBe(logoDataUrl);
    expect(accounts.saveProfessionalData).toHaveBeenCalledExactlyOnceWith(USER_ID, expect.objectContaining({ profile: expect.objectContaining({ logoDataUrl }) }));

    const refresh = new NextRequest("https://siteinsight.example/api/account/professional-profile");
    const loaded = await GET(refresh, {} as never);
    expect(loaded.status).toBe(200);
    expect((await loaded.json()).data.professional.profile.logoDataUrl).toBe(logoDataUrl);
    expect(accounts.getProfessionalData).toHaveBeenCalledExactlyOnceWith(USER_ID);
  });
});
