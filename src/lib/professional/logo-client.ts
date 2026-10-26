import { MAX_LOGO_DIMENSION, MAX_LOGO_PIXELS } from "./logo-limits";

export interface LogoRasterDimensions {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const JPEG_START_OF_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function safeDimensions(width: number, height: number): LogoRasterDimensions | null {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 &&
    width <= MAX_LOGO_DIMENSION && height <= MAX_LOGO_DIMENSION && width * height <= MAX_LOGO_PIXELS
    ? { width, height }
    : null;
}

/** Reads only bounded image headers; callers should fully decode after these limits pass. */
export function parseLogoDimensions(bytes: Uint8Array, mimeType: string): LogoRasterDimensions | null {
  if (mimeType === "image/png") {
    if (bytes.length < 24 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value) ||
        String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return safeDimensions(view.getUint32(16, false), view.getUint32(20, false));
  }
  if (mimeType !== "image/jpeg" || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (segmentLength < 7 || offset + 7 > bytes.length) return null;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return safeDimensions(width, height);
    }
    offset += segmentLength;
  }
  return null;
}
