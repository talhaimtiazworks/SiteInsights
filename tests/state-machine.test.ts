import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, hasResults, InvalidTransitionError, isTerminal } from "@/lib/scans/state-machine";

describe("scan state machine", () => {
  it("allows the normal lifecycle", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("running", "completed_with_warnings")).toBe(true);
    expect(canTransition("running", "failed")).toBe(true);
    expect(canTransition("queued", "cancelled")).toBe(true);
    expect(canTransition("running", "cancelled")).toBe(true);
  });
  it("forbids leaving terminal states and skipping states", () => {
    for (const t of ["completed", "completed_with_warnings", "failed", "cancelled"] as const) {
      expect(isTerminal(t)).toBe(true);
      expect(canTransition(t, "running")).toBe(false);
      expect(() => assertTransition(t, "running")).toThrow(InvalidTransitionError);
    }
    expect(canTransition("queued", "completed")).toBe(false);
  });
  it("only completed states have results", () => {
    expect(hasResults("completed")).toBe(true);
    expect(hasResults("completed_with_warnings")).toBe(true);
    expect(hasResults("failed")).toBe(false);
    expect(hasResults("cancelled")).toBe(false);
    expect(hasResults("running")).toBe(false);
  });
});
