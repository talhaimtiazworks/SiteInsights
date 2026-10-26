import { MAX_LOGO_BYTES, MAX_LOGO_DATA_URL_CHARS, MAX_LOGO_DIMENSION, MAX_LOGO_PIXELS } from "./logo-limits";

export { MAX_LOGO_BYTES, MAX_LOGO_BASE64_CHARS, MAX_LOGO_DATA_URL_CHARS, MAX_LOGO_DIMENSION, MAX_LOGO_PIXELS } from "./logo-limits";

export interface DecodedLogo {
  mimeType: "image/png" | "image/jpeg";
  bytes: Buffer;
  width: number;
  height: number;
}

function safeDimensions(width: number, height: number) {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width <= MAX_LOGO_DIMENSION && height <= MAX_LOGO_DIMENSION && width * height <= MAX_LOGO_PIXELS;
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return safeDimensions(width, height) ? { width, height } : null;
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (startOfFrame.has(marker)) {
      if (segmentLength < 7 || offset + 7 > bytes.length) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return safeDimensions(width, height) ? { width, height } : null;
    }
    offset += segmentLength;
  }
  return null;
}

/** Validates a bounded data-URI PNG/JPEG including raster dimensions before any PDF decoder sees it. */
export function decodeLogoDataUrl(value: unknown): DecodedLogo | null {
  if (typeof value !== "string" || value.length > MAX_LOGO_DATA_URL_CHARS) return null;
  const match = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_LOGO_BYTES || bytes.toString("base64") !== match[2]) return null;
  const dims = match[1] === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  return dims ? { mimeType: match[1] as DecodedLogo["mimeType"], bytes, ...dims } : null;
}
