import Link from "next/link";
import { BRAND, brandCopyright } from "@/lib/brand";
import { LogoMark, Wordmark } from "./brand";

const COLUMNS: Array<{ title: string; links: Array<[string, string]> }> = [
  { title: "Product", links: [["/features", "Features"], ["/guide", "Guide"], ["/audit/new", "New audit"], ["/dashboard", "Dashboard"]] },
  { title: "Resources", links: [["/help", "Help & docs"], ["/about", "About SiteInsights"], ["/contact", "Contact"]] },
  { title: "Legal", links: [["/privacy", "Privacy"], ["/terms", "Terms"]] },
];

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t-4 border-gold bg-charcoal text-white/80 print:hidden">
      <div className="container grid gap-10 py-12 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="max-w-sm">
          <div className="flex items-center gap-3">
            <LogoMark className="h-12 w-12" tile /> <Wordmark className="text-xl text-white" />
          </div>
          <p className="mt-3 text-sm">{BRAND.tagline}</p>
          <p className="mt-3 text-xs font-medium uppercase tracking-wider text-gold">{BRAND.attribution}</p>
        </div>
        {COLUMNS.map((c) => (
          <nav key={c.title} aria-label={c.title}>
            <p className="text-xs font-semibold uppercase tracking-wider text-white">{c.title}</p>
            <ul className="mt-3 space-y-1 text-sm">
              {c.links.map(([href, label]) => (
                <li key={href}>
                  <Link className="inline-flex min-h-8 items-center hover:text-white hover:underline hover:underline-offset-4" href={href}>{label}</Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-white/10">
        <div className="container flex flex-col gap-1 py-4 text-xs text-white/60 sm:flex-row sm:justify-between">
          <p>{brandCopyright()}</p>
          <p>Automated checks can miss issues or flag false positives. Review findings before acting on them.</p>
        </div>
      </div>
    </footer>
  );
}
