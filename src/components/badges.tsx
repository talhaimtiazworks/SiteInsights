import type { Severity } from "@/lib/audit/types";
import { SEVERITY_LABELS } from "@/lib/audit/types";
import type { ScanStatus } from "@/lib/scanner/types";
import { STATUS_LABELS } from "@/lib/scans/state-machine";
import { Badge, cn } from "./ui";

export const SEVERITY_STYLES: Record<Severity, { badge: string; dot: string; text: string }> = {
  critical: { badge: "border-danger/30 bg-danger-soft text-danger", dot: "bg-danger", text: "text-danger" },
  high: { badge: "border-warning/30 bg-warning-soft text-warning", dot: "bg-brand-orange", text: "text-warning" },
  medium: { badge: "border-warning/30 bg-warning-soft text-warning", dot: "bg-brand-amber", text: "text-warning" },
  low: { badge: "border-info/30 bg-info-soft text-info", dot: "bg-info", text: "text-info" },
  info: { badge: "border-border bg-muted text-muted-foreground", dot: "bg-muted", text: "text-muted-foreground" },
};

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <Badge className={cn(SEVERITY_STYLES[severity].badge, className)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", SEVERITY_STYLES[severity].dot)} aria-hidden="true" />
      {SEVERITY_LABELS[severity]}
    </Badge>
  );
}

const STATUS_STYLES: Record<ScanStatus, string> = {
  queued: "border-border bg-muted text-muted-foreground",
  running: "border-primary/30 bg-primary/10 text-primary",
  completed: "border-success/30 bg-success-soft text-success",
  completed_with_warnings: "border-warning/30 bg-warning-soft text-warning",
  failed: "border-danger/30 bg-danger-soft text-danger",
  cancelled: "border-border bg-muted text-muted-foreground",
};

export function StatusBadge({ status }: { status: ScanStatus }) {
  return <Badge className={STATUS_STYLES[status]}>{STATUS_LABELS[status]}</Badge>;
}

const TYPE_LABELS = { error: "Error", recommendation: "Recommendation", observation: "Observation" } as const;
export function TypeBadge({ type }: { type: keyof typeof TYPE_LABELS }) {
  return <Badge className="border-border bg-muted text-muted-foreground">{TYPE_LABELS[type]}</Badge>;
}
