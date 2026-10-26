import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { ApiError, readBodyText, readJson } from "@/lib/http/api";
import { MAX_LOGO_BYTES, MAX_LOGO_DATA_URL_CHARS, MAX_PROFESSIONAL_PROFILE_BODY_BYTES } from "@/lib/professional/logo-limits";

function requestWithChunks(chunks: Uint8Array[], headers: Record<string, string> = {}, onCancel?: () => void) {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close(); },
    cancel() { onCancel?.(); },
  });
  return new Request("https://test.example/api", { method: "POST", headers, body, duplex: "half" } as RequestInit & { duplex: "half" });
}

describe("streaming request-body limits", () => {
  it("keeps maximum-logo data-URI parsing within a finite, explicit profile-body cap", () => {
    expect(MAX_LOGO_BYTES).toBe(1_048_576);
    expect(MAX_LOGO_DATA_URL_CHARS).toBe(1_398_127);
    expect(MAX_PROFESSIONAL_PROFILE_BODY_BYTES).toBe(2_097_152);
  });

  it("counts actual UTF-8 bytes across chunks, including split multibyte characters", async () => {
    const bytes = new TextEncoder().encode('{"note":"🌿"}');
    const request = requestWithChunks([bytes.slice(0, 10), bytes.slice(10, 12), bytes.slice(12)]);
    await expect(readBodyText(request, bytes.byteLength)).resolves.toBe('{"note":"🌿"}');
  });

  it("rejects an unknown-length chunked body as soon as the byte cap is crossed and cancels the stream", async () => {
    let cancelled = false;
    const request = requestWithChunks([new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)], {}, () => { cancelled = true; });
    await expect(readBodyText(request, 7)).rejects.toMatchObject({ status: 413, code: "payload_too_large" });
    expect(cancelled).toBe(true);
  });

  it("uses Content-Length only as an early rejection hint", async () => {
    const request = requestWithChunks([new Uint8Array(1)], { "content-length": "100" });
    await expect(readBodyText(request, 8)).rejects.toBeInstanceOf(ApiError);
  });

  it("applies the same byte cap before parsing JSON", async () => {
    const bytes = new TextEncoder().encode('{"x":"é"}');
    const request = requestWithChunks([bytes]) as unknown as NextRequest;
    await expect(readJson(request, bytes.byteLength - 1)).rejects.toMatchObject({ status: 413, code: "payload_too_large" });
    const valid = requestWithChunks([bytes]) as unknown as NextRequest;
    await expect(readJson(valid, bytes.byteLength)).resolves.toEqual({ x: "é" });
  });
});
