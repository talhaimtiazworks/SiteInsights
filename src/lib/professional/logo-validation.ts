import "server-only";
import sharp from "sharp";
import { decodeLogoDataUrl } from "./logo";
import { MAX_LOGO_DIMENSION, MAX_LOGO_PIXELS } from "./logo-limits";

/** Performs a bounded native decode after the cheap format/base64/dimension checks. */
export async function fullyDecodeLogoDataUrl(value: unknown): Promise<boolean> {
  const decoded = decodeLogoDataUrl(value);
  if (!decoded) return false;
  try {
    const decoder = sharp(decoded.bytes, {
      failOn: "warning",
      limitInputPixels: MAX_LOGO_PIXELS,
      sequentialRead: true,
    });
    const metadata = await decoder.metadata();
    const expectedFormat = decoded.mimeType === "image/png" ? "png" : "jpeg";
    if (
      metadata.format !== expectedFormat ||
      metadata.width !== decoded.width ||
      metadata.height !== decoded.height ||
      !metadata.width || !metadata.height ||
      metadata.width > MAX_LOGO_DIMENSION ||
      metadata.height > MAX_LOGO_DIMENSION ||
      metadata.width * metadata.height > MAX_LOGO_PIXELS ||
      (metadata.pages ?? 1) !== 1
    ) return false;

    // Force libvips to decode pixels while keeping the resulting allocation tiny.
    // The compressed input has already been capped at 1 MiB and source pixels at 2 MP.
    const { data, info } = await decoder.resize({ width: 1, height: 1, fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return info.width >= 1 && info.height >= 1 && data.length > 0 && data.length <= 4;
  } catch {
    return false;
  }
}
