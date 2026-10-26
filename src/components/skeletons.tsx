import { Card, LoadingRegion, Skeleton } from "./ui";

/** Skeletons mirror the real layouts so content doesn't jump when it arrives. */

export function StatCardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} className="space-y-2 p-4">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-14" />
          <Skeleton className="h-3 w-24" />
        </Card>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <Card className={className}>
      <div className="border-b p-4">
        <Skeleton className="h-4 w-40" />
      </div>
      <ul className="divide-y">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="flex items-center gap-3 p-4">
            <Skeleton className="h-5 w-16 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function ReportSkeleton() {
  return (
    <LoadingRegion label="Loading report" className="container space-y-6 py-10">
      <div className="space-y-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-8 w-2/3 max-w-lg" />
        <Skeleton className="h-3 w-56" />
      </div>
      <StatCardsSkeleton />
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Card key={i} className="space-y-2 p-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 w-10" />
          </Card>
        ))}
      </div>
      <TableSkeleton rows={6} />
    </LoadingRegion>
  );
}

export function IssueSkeleton() {
  return (
    <LoadingRegion label="Loading issue" className="container max-w-4xl space-y-6 py-10">
      <Skeleton className="h-3 w-48" />
      <Skeleton className="h-8 w-3/4" />
      <div className="flex gap-2">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-24" />
      </div>
      <Card className="space-y-3 p-6">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-2/3" />
      </Card>
      <TableSkeleton rows={4} />
    </LoadingRegion>
  );
}

export function ListPageSkeleton({ label, title = true }: { label: string; title?: boolean }) {
  return (
    <LoadingRegion label={label} className="container space-y-6 py-8 sm:py-10">
      {title ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
      ) : null}
      <StatCardsSkeleton count={3} />
      <TableSkeleton rows={5} />
    </LoadingRegion>
  );
}

export function DashboardSkeleton() {
  return (
    <LoadingRegion label="Loading dashboard" className="container space-y-8 py-10">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Card className="space-y-3 p-5">
        <Skeleton className="h-4 w-32" />
        <div className="flex flex-col gap-3 sm:flex-row">
          <Skeleton className="h-11 flex-1" />
          <Skeleton className="h-11 w-full sm:w-36" />
        </div>
      </Card>
      <StatCardsSkeleton />
      <TableSkeleton rows={5} />
    </LoadingRegion>
  );
}

export function ProgressSkeleton() {
  return (
    <LoadingRegion label="Loading audit progress" className="container max-w-3xl space-y-6 py-10">
      <div className="space-y-2">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-48" />
      </div>
      <Card className="space-y-4 p-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-6 w-6 shrink-0 rounded-full" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ))}
      </Card>
      <StatCardsSkeleton count={4} />
    </LoadingRegion>
  );
}

/** `embedded`: rendered inside a layout that already provides the page container (account settings). */
export function SettingsSkeleton({ label, embedded = false }: { label: string; embedded?: boolean }) {
  return (
    <LoadingRegion label={label} className={embedded ? "space-y-6" : "container max-w-4xl space-y-6 py-10"}>
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      {Array.from({ length: 3 }, (_, i) => (
        <Card key={i} className="space-y-3 p-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </Card>
      ))}
    </LoadingRegion>
  );
}

export function WorkspaceRouteSkeleton({ label }: { label: string }) {
  return (
    <LoadingRegion label={label} className="container space-y-6 py-8 sm:py-10">
      <div className="space-y-2"><Skeleton className="h-8 w-48" /><Skeleton className="h-4 w-72 max-w-full" /></div>
      <Card className="space-y-3 p-5"><Skeleton className="h-4 w-36" /><div className="flex flex-col gap-3 sm:flex-row"><Skeleton className="h-11 min-w-0 flex-1" /><Skeleton className="h-11 w-full sm:w-36" /></div></Card>
      <StatCardsSkeleton count={4} />
      <TableSkeleton rows={4} />
    </LoadingRegion>
  );
}

export function AuthRouteSkeleton({ label }: { label: string }) {
  return (
    <LoadingRegion label={label} className="container flex justify-center py-10 sm:py-16">
      <Card className="w-full max-w-md space-y-5 p-6 sm:p-8">
        <div className="flex items-center gap-4"><Skeleton className="size-16 shrink-0 rounded-lg" /><div className="space-y-2"><Skeleton className="h-4 w-28" /><Skeleton className="h-3 w-20" /></div></div>
        <div className="space-y-2"><Skeleton className="h-8 w-48 max-w-full" /><Skeleton className="h-4 w-full" /></div>
        <Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" />
      </Card>
    </LoadingRegion>
  );
}

export function AuditRouteSkeleton({ label }: { label: string }) {
  return (
    <LoadingRegion label={label} className="container max-w-4xl space-y-6 py-10">
      <div className="space-y-2"><Skeleton className="h-8 w-56 max-w-full" /><Skeleton className="h-4 w-80 max-w-full" /></div>
      <Card className="space-y-4 p-5 sm:p-6"><div className="flex flex-col gap-2 sm:flex-row"><Skeleton className="h-12 min-w-0 flex-1" /><Skeleton className="h-12 w-full sm:w-36" /></div><Skeleton className="h-4 w-64 max-w-full" /><Skeleton className="h-10 w-full" /></Card>
      <div className="grid gap-3 sm:grid-cols-2"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
    </LoadingRegion>
  );
}
