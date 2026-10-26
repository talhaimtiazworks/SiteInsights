import type { ScanStatus } from "../scanner/types";

/**
 * Explicit scan lifecycle. Terminal states never transition again, so a failed
 * or cancelled scan can never later appear as completed.
 */
const TRANSITIONS: Record<ScanStatus, readonly ScanStatus[]> = {
  queued: ["running", "cancelled", "failed"],
  running: ["completed", "completed_with_warnings", "failed", "cancelled"],
  completed: [],
  completed_with_warnings: [],
  failed: [],
  cancelled: [],
};

export const ACTIVE_STATUSES: ScanStatus[] = ["queued", "running"];
export const TERMINAL_STATUSES: ScanStatus[] = ["completed", "completed_with_warnings", "failed", "cancelled"];

export function canTransition(from: ScanStatus, to: ScanStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(public from: ScanStatus, public to: ScanStatus) {
    super(`Invalid scan state transition: ${from} → ${to}`);
  }
}

export function assertTransition(from: ScanStatus, to: ScanStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(s: ScanStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

/** Only these statuses may display audit results. */
export function hasResults(s: ScanStatus): boolean {
  return s === "completed" || s === "completed_with_warnings";
}

export const STATUS_LABELS: Record<ScanStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  completed_with_warnings: "Completed with warnings",
  failed: "Failed",
  cancelled: "Cancelled",
};
