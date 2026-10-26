import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { fullyDecodeLogoDataUrl } from "@/lib/professional/logo-validation";
import { MAX_LOGO_BYTES } from "@/lib/professional/logo-limits";

const dataUrl = (mime: "image/png" | "image/jpeg", bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`;

async function image(format: "png" | "jpeg") {
  return sharp({ create: { width: 8, height: 6, channels: 4, background: { r: 34, g: 103, b: 168, alpha: 1 } } })
    .toFormat(format)
    .toBuffer();
}

describe("bounded logo content decoder", () => {
  it("fully decodes real PNG and JPEG pixel data", async () => {
    const png = await image("png");
    const jpeg = await image("jpeg");
    expect(await fullyDecodeLogoDataUrl(dataUrl("image/png", png))).toBe(true);
    expect(await fullyDecodeLogoDataUrl(dataUrl("image/jpeg", jpeg))).toBe(true);
  });

  it("rejects a signature and plausible dimensions without decodable image content", async () => {
    const fake = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(fake, 0);
    fake.write("IHDR", 12, "ascii");
    fake.writeUInt32BE(2, 16);
    fake.writeUInt32BE(2, 20);
    expect(await fullyDecodeLogoDataUrl(dataUrl("image/png", fake))).toBe(false);
  });

  it("rejects a valid image wrapped in the wrong MIME type and oversized bytes", async () => {
    const png = await image("png");
    const jpeg = await image("jpeg");
    expect(await fullyDecodeLogoDataUrl(dataUrl("image/jpeg", png))).toBe(false);
    expect(await fullyDecodeLogoDataUrl(dataUrl("image/png", Buffer.alloc(MAX_LOGO_BYTES + 1)))).toBe(false);
    expect(await fullyDecodeLogoDataUrl("data:image/svg+xml;base64,PHN2Zy8+" )).toBe(false);
    expect(await fullyDecodeLogoDataUrl(dataUrl("image/jpeg", jpeg))).toBe(true);
  });
});
