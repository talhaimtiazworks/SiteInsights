import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { SeverityBadge } from "@/components/badges";
import { CATEGORIES, CATEGORY_LABELS, SEVERITIES, SEVERITY_LABELS, SEVERITY_ORDER } from "@/lib/audit/types";
import { BRAND } from "@/lib/brand";
import { getRepository } from "@/lib/db";
import { ApiError } from "@/lib/http/api";
import { resolveShare } from "@/lib/services/shares";

// Shared links are private by default: never indexed, never cached, never leak the token via Referer.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Shared website audit",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: "no-referrer",
};

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "—");
const host = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
};

/** Read-only client view of one audit, reached through an expiring, revocable token. Verified findings only; no AI content. */
export default async function SharedReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let resolved: Awaited<ReturnType<typeof resolveShare>>;
  try {
    resolved = await resolveShare(token);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const { share, scan, snapshot } = resolved;
  const frozen = snapshot?.content;
  const findings = frozen ? [...frozen.findings] : (await getRepository().listFindings(scan.id)).filter((f) => f.resolution?.status !== "ignored");
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.affectedCount - a.affectedCount);
  const reportScan = frozen?.scan ?? scan;
  const s = reportScan.summary;
  const professional = frozen?.professional ?? null;
  const site = host(reportScan.targetUrl);
  const counts = Object.fromEntries(SEVERITIES.map((sv) => [sv, findings.filter((f) => f.severity === sv).length]));
  const profileTypeLabel = professional?.profileType === "agency" ? "Agency" : professional?.profileType === "freelancer" ? "Freelancer" : null;
  const identity = [professional?.professionalName, professional?.businessName, professional?.jobTitle, profileTypeLabel].filter(Boolean);

  return (
    <div className="container max-w-5xl py-10 sm:py-14">
      <header className="border-b pb-8" style={professional?.brandColors?.[0] ? { borderColor: professional.brandColors[0] } : undefined}>
        <p className="eyebrow text-primary">Shared website audit · {BRAND.name}</p>
        <div className="mt-3 flex flex-wrap items-start gap-4">
          {professional?.logoDataUrl ? <Image src={professional.logoDataUrl} alt="Published professional logo" width={64} height={64} unoptimized className="h-16 w-16 rounded border bg-white object-contain p-1" /> : null}
          <div className="min-w-0 flex-1">
            <h1 className="break-words text-[2rem] font-bold leading-tight tracking-display sm:text-[2.5rem]">{site}</h1>
            {professional?.headline ? <p className="mt-2 text-base font-medium" style={professional.brandColors?.[0] ? { color: professional.brandColors[0] } : undefined}>{professional.headline}</p> : null}
            {identity.length ? <p className="mt-1 text-sm text-secondary">{identity.join(" · ")}</p> : null}
            {professional?.biography ? <p className="mt-2 max-w-3xl whitespace-pre-wrap text-sm text-secondary">{professional.biography}</p> : null}
            {professional?.location ? <p className="mt-2 text-sm text-muted-foreground">{professional.location}</p> : null}
            <p className="mt-2 text-sm text-secondary">Audited {fmtDate(reportScan.finishedAt)} · {s?.pagesScanned ?? 0} pages scanned (limit {reportScan.limits.maxPages}) · link expires {fmtDate(share.expiresAt)}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {professional?.websiteUrl ? <a href={professional.websiteUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline underline-offset-4">Website</a> : null}
              {professional?.contactEmail ? <a href={`mailto:${professional.contactEmail}`} className="text-primary underline underline-offset-4">{professional.contactEmail}</a> : null}
              {professional?.contactPhone ? <span>{professional.contactPhone}</span> : null}
            </div>
          </div>
        </div>
        {share.snapshotVersion ? <p className="mt-3 text-xs text-muted-foreground">Report snapshot v{share.snapshotVersion} · frozen when this link was created</p> : null}
        {share.allowPdf ? (
          <a href={`/api/share/${encodeURIComponent(token)}/report.pdf`} rel="nofollow noreferrer" className="mt-5 inline-flex h-10 items-center rounded-md border border-primary bg-primary px-4 text-sm font-semibold text-white hover:bg-primary-hover">
            Download PDF report
          </a>
        ) : null}
      </header>

      <section aria-labelledby="summary" className="mt-8">
        <h2 id="summary" className="sr-only">Summary</h2>
        <dl className="grid grid-cols-2 overflow-hidden rounded-lg border sm:grid-cols-4">
          {[
            ["Pages scanned", s?.pagesScanned ?? 0],
            ["Links checked", s?.linksChecked ?? 0],
            ["Broken links", s?.brokenLinks ?? 0],
            ["Issues", findings.length],
          ].map(([label, value], i) => (
            <div key={String(label)} className={`p-4 ${i > 0 ? "border-l" : ""} ${i > 1 ? "border-t sm:border-t-0" : ""} ${i === 2 ? "border-l-0 sm:border-l" : ""}`}>
              <dt className="text-xs uppercase tracking-wider text-muted-foreground">{label}</dt>
              <dd className="mt-1 font-display text-2xl font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {s ? (
          <div className="mt-6 grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            {CATEGORIES.map((c) => {
              const v = s.scores[c];
              return (
                <div key={c}>
                  <div className="flex items-baseline justify-between text-sm"><span>{CATEGORY_LABELS[c]}</span><span className="font-semibold tabular-nums">{v ?? "Not evaluated"}</span></div>
                  <div className="mt-1 h-1.5 bg-muted"><div className={`h-full ${v === null || v === undefined ? "" : v >= 90 ? "bg-success" : v >= 70 ? "bg-gold" : "bg-danger"}`} style={{ width: `${v ?? 0}%` }} /></div>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="findings" className="mt-12">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="findings" className="text-2xl font-semibold tracking-tight">Verified findings</h2>
          <p className="text-xs text-muted-foreground" data-numeric>{SEVERITIES.filter((sv) => counts[sv]).map((sv) => `${counts[sv]} ${SEVERITY_LABELS[sv].toLowerCase()}`).join(" · ") || "None"}</p>
        </div>
        <p className="mt-2 text-sm text-secondary">Each finding comes from an automated check of the pages listed. No AI-generated content is included in this shared view.</p>
        {findings.length === 0 ? (
          <p className="mt-6 rounded-lg border p-6 text-sm text-secondary">No issues were found on the pages scanned.</p>
        ) : (
          <ol className="mt-6 divide-y border-y">
            {findings.map((f) => (
              <li key={f.id} className="py-5">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={f.severity} />
                  <h3 className="font-sans text-base font-semibold">{f.title}</h3>
                  <span className="text-xs text-muted-foreground">{CATEGORY_LABELS[f.category]} · {f.affectedCount} page{f.affectedCount === 1 ? "" : "s"}</span>
                </div>
                <p className="mt-2 text-sm text-secondary"><span className="font-medium text-foreground">Evidence:</span> {f.evidence.summary}</p>
                <p className="mt-1 text-sm text-secondary"><span className="font-medium text-foreground">Recommendation:</span> {f.recommendation}</p>
                {(f.affectedUrls.length ? f.affectedUrls : [f.affectedUrl]).filter(Boolean).length ? (
                  <ul className="mt-2 space-y-0.5 font-mono text-xs text-muted-foreground">
                    {(f.affectedUrls.length ? f.affectedUrls : [f.affectedUrl]).filter(Boolean).slice(0, 5).map((u) => <li key={u} className="truncate">{u}</li>)}
                    {f.affectedCount > 5 ? <li>+ {f.affectedCount - 5} more</li> : null}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      {frozen && (frozen.matchedServices.length > 0 || frozen.portfolio.length > 0) ? (
        <section aria-labelledby="professional-services" className="mt-12">
          <h2 id="professional-services" className="text-2xl font-semibold tracking-tight">Services matched to this audit</h2>
          <p className="mt-2 text-sm text-secondary">These published services were matched deterministically to open, verified findings by audit category or configured keywords. The match does not verify credentials, guarantee results or imply work has been completed.</p>
          {frozen.matchedServices.length ? <ul className="mt-5 divide-y border-y">{frozen.matchedServices.map((service) => <li key={service.serviceId} className="py-4"><h3 className="font-semibold">{service.title}</h3>{service.description ? <p className="mt-1 text-sm text-secondary">{service.description}</p> : null}<p className="mt-2 text-xs text-muted-foreground">Matched evidence: {service.matchedFindings.map((f) => `${f.title} (${f.severity})`).join(" · ")}</p></li>)}</ul> : null}
          {frozen.portfolio.length ? <div className="mt-6"><h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Relevant portfolio</h3><ul className="mt-2 grid gap-3 sm:grid-cols-2">{frozen.portfolio.map((item) => <li key={item.id} className="rounded-lg border p-4"><h4 className="font-semibold">{item.title}</h4>{item.description ? <p className="mt-1 text-sm text-secondary">{item.description}</p> : null}<a href={item.projectUrl} target="_blank" rel="noopener noreferrer nofollow" className="mt-2 inline-block text-sm text-primary underline underline-offset-4">View project</a></li>)}</ul></div> : null}
        </section>
      ) : null}

      <footer className="mt-10 text-xs leading-5 text-muted-foreground">
        <p>Automated checks can miss issues or flag false positives. Results reflect the site at the time of the audit; pages outside the scanned sample were not checked.</p>
        <p className="mt-1">Report generated with {BRAND.name}. {BRAND.attribution}</p>
      </footer>
    </div>
  );
}
