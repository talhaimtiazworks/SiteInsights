import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/ui";
export { cn };

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary: "border border-primary bg-primary text-white hover:bg-primary-hover hover:border-primary-hover",
  secondary: "border border-gold bg-gold text-charcoal hover:bg-[#E9A72C] hover:border-[#E9A72C]",
  outline: "border border-charcoal/20 bg-card text-foreground hover:border-primary hover:text-primary",
  ghost: "text-foreground hover:bg-muted",
  danger: "border border-danger bg-danger text-white hover:opacity-90",
};
const sizes: Record<Size, string> = {
  sm: "min-h-9 px-3.5 py-2 text-sm gap-1.5",
  md: "min-h-11 px-5 py-3 text-sm gap-2",
  lg: "min-h-12 px-6 py-3 text-[0.9375rem] gap-2",
};

export function buttonClass(variant: Variant = "primary", size: Size = "md", extra?: string) {
  return cn("inline-flex max-w-full items-center justify-center rounded-xl text-center font-semibold whitespace-normal transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out motion-safe:hover:-translate-y-px motion-safe:hover:shadow-soft motion-safe:active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:transform-none", variants[variant], sizes[size], extra);
}

export function Button({ variant = "primary", size = "md", className, ...props }: ComponentProps<"button"> & { variant?: Variant; size?: Size }) {
  return <button className={buttonClass(variant, size, className)} {...props} />;
}

export function ButtonLink({ variant = "primary", size = "md", className, ...props }: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("ui-card min-w-0 rounded-xl border border-border/80 bg-card", className)} {...props} />;
}

export function CardHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4", className)}>
      <div className="min-w-0">
        <h2 className="font-display text-[1.0625rem] font-semibold tracking-tight">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Badge({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium", className)} {...props} />;
}

const alertStyles = {
  info: "border-info/25 bg-info-soft text-info",
  warning: "border-warning/25 bg-warning-soft text-warning",
  error: "border-danger/25 bg-danger-soft text-danger",
  success: "border-success/25 bg-success-soft text-success",
};

export function Alert({ tone = "info", title, children, className }: { tone?: keyof typeof alertStyles; title?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("ui-enter rounded-md border px-4 py-3 text-sm", alertStyles[tone], className)}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={cn(title ? "mt-1" : "", "leading-6 opacity-90")}>{children}</div> : null}
    </div>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn("h-11 w-full rounded-md border border-charcoal/20 bg-card px-3 text-sm placeholder:text-muted-foreground transition-[border-color,box-shadow] duration-150 focus:border-primary disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn("h-11 max-w-full rounded-md border border-charcoal/20 bg-card px-3 text-sm transition-[border-color,box-shadow] duration-150 focus:border-primary disabled:cursor-not-allowed disabled:opacity-60", className)} {...props} />;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("h-4 w-4 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

export function ProgressBar({ value, className, label }: { value: number; className?: string; label?: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-sm bg-muted", className)} role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${v}%` }} />
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ui-enter flex flex-col items-center justify-center px-6 py-12 text-center">
      <p className="font-display text-lg font-semibold tracking-tight">{title}</p>
      {children ? <div className="mt-1 max-w-md text-sm text-muted-foreground">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}

export function PageHeader({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ui-page-header ui-enter flex flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-7 sm:py-6">
      <div className="min-w-0">
        <h1 className="font-display text-[1.75rem] font-semibold leading-tight tracking-display sm:text-[2.125rem]">{title}</h1>
        {description ? <p className="mt-1 text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

/** Placeholder block shown while content loads. Animation respects prefers-reduced-motion. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)} />;
}

/** Accessible loading region: screen readers hear the label once, sighted users see skeletons. */
export function LoadingRegion({ label, children, className }: { label: string; children?: ReactNode; className?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}
