"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "./ui";

const TABS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/audits", label: "Audits" },
  { href: "/dashboard/compare", label: "Compare" },
  { href: "/dashboard/prospects", label: "Prospects" },
  { href: "/dashboard/batches", label: "Batch audits" },
];

export function DashboardNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Dashboard" className="flex gap-1 overflow-x-auto border-b">
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined} className={cn("-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition", active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:border-border hover:text-foreground")}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
