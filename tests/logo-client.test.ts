import { describe, expect, it } from "vitest";
import { parseLogoDimensions } from "@/lib/professional/logo-client";

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x08, 0x08,
    height >> 8, height & 0xff,
    width >> 8, width & 0xff,
    0x01,
  ]);
}

describe("bounded browser-side logo header checks", () => {
  it("reads allowed PNG and JPEG dimensions before decoding", () => {
    expect(parseLogoDimensions(pngHeader(2048, 976), "image/png")).toEqual({ width: 2048, height: 976 });
    expect(parseLogoDimensions(jpegHeader(800, 600), "image/jpeg")).toEqual({ width: 800, height: 600 });
  });

  it("rejects over-dimension, over-pixel, malformed and unsupported files", () => {
    expect(parseLogoDimensions(pngHeader(2049, 1), "image/png")).toBeNull();
    expect(parseLogoDimensions(pngHeader(2048, 977), "image/png")).toBeNull();
    expect(parseLogoDimensions(new Uint8Array(24), "image/png")).toBeNull();
    expect(parseLogoDimensions(pngHeader(10, 10), "image/jpeg")).toBeNull();
    expect(parseLogoDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xda]), "image/jpeg")).toBeNull();
    expect(parseLogoDimensions(pngHeader(10, 10), "image/svg+xml")).toBeNull();
  });
});
