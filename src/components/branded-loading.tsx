import { LogoMark } from "./brand";
import { cn } from "@/lib/ui";

/** Honest, indeterminate feedback: no artificial completion percentage or minimum duration. */
export function BrandedLoading({ label = "Loading your workspace…", compact = false, className }: { label?: string; compact?: boolean; className?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={cn("branded-loading", compact ? "flex items-center gap-3 rounded-xl border bg-card px-4 py-3" : "flex flex-col items-center justify-center gap-4 rounded-2xl border bg-card px-6 py-8 text-center", className)}>
      <LogoMark title="TalhaImtiazWorks official logo" className={compact ? "h-11 w-11" : "h-20 w-20"} />
      <div className={cn("min-w-0", !compact && "w-full max-w-xs")}>
        <p className="text-sm font-medium text-foreground">{label}</p>
        {!compact ? <p className="mt-1 text-xs text-muted-foreground">SiteInsights · by TalhaImtiazWorks</p> : null}
        <div aria-hidden="true" className="mt-2.5 h-1 overflow-hidden rounded-full bg-brand-primary/15">
          <div className="brand-loading-track h-full w-1/3 rounded-full bg-accent" />
        </div>
      </div>
    </div>
  );
}
