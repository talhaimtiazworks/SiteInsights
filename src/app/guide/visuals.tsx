import type { ReactNode } from "react";
import { ACQUISITION_FLOW, FUNNEL_STAGES, NICHE_CRITERIA, NICHES, PRIORITY_EXAMPLES, PROCESS_STEPS, SEVEN_DAYS } from "./data";

/**
 * Guide visualizations. All semantic, responsive HTML/CSS/SVG — no chart
 * dependency, no placeholder screenshots, no decorative filler. Icon glyphs
 * are simple original shapes (no copied brand marks required here).
 * Colors come from the TIW palette (dark-surface hexes as accents) and the
 * site's CSS-variable design tokens elsewhere; this app ships a single light theme.
 */

const TIW = {
  purple: "#44174E",
  violet: "#662249",
  navy: "#14122A",
  deepViolet: "#241D3D",
  cyan: "#03D2D2",
  gold: "#FFC422",
  orange: "#FF8200",
  ivory: "#F8F7F3",
  white: "#FFFFFF",
} as const;

const STAGE_COLORS = [TIW.cyan, TIW.gold, TIW.orange, TIW.violet, TIW.cyan, TIW.gold, TIW.orange];

function StageGlyph({ n }: { n: number }) {
  // Seven distinct minimal glyphs, drawn as abstract icon shapes.
  const paths = [
    // 1 find — magnifier
    <g key={n}><circle cx="10" cy="10" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M14 14l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></g>,
    // 2 inspect — eye
    <g key={n}><path d="M2 12c3-5 6.5-7 10-7s7 2 10 7c-3 5-6.5 7-10 7s-7-2-10-7z" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="12" cy="12" r="2.6" fill="currentColor" /></g>,
    // 3 validate — check in circle
    <g key={n}><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M8 12.5l2.6 2.6L16.5 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></g>,
    // 4 report — document
    <g key={n}><rect x="6" y="4" width="12" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M9 9h6M9 13h6M9 17h3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></g>,
    // 5 contact — phone
    <g key={n}><path d="M7 4h3l1.5 4-2 1.5a10 10 0 0 0 5 5l1.5-2 4 1.5v3c0 1-1 2-2 2C11 19 5 13 5 6c0-1 1-2 2-2z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></g>,
    // 6 discuss — chat bubbles
    <g key={n}><path d="M4 5h11v8H9l-3.5 3V13H4z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><path d="M17 9h3v7l-1.5 0V18l-3-2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></g>,
    // 7 win — trophy
    <g key={n}><path d="M8 4h8v5a4 4 0 0 1-8 0z" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M8 5H4.5v2.5A3.5 3.5 0 0 0 8 11M16 5h3.5v2.5A3.5 3.5 0 0 1 16 11M12 13v3m-3.5 4h7M12 16c1.8 0 3.5 1 3.5 4h-7c0-3 1.7-4 3.5-4z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></g>,
  ];
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6">{paths[n - 1]}</svg>;
}

/** Section 1 — find → inspect → validate → report → contact → discuss → win. */
export function AcquisitionFlow() {
  return (
    <figure aria-label="Client acquisition flow in seven stages" className="min-w-0 rounded-2xl p-5 sm:p-7" style={{ background: TIW.navy }}>
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-7 lg:gap-2">
        {ACQUISITION_FLOW.map((s, i) => {
          const c = STAGE_COLORS[i];
          return (
            <li key={s.n} className="relative flex gap-3 rounded-xl p-3 lg:flex-col lg:gap-2 lg:text-center" style={{ background: TIW.deepViolet }}>
              <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full font-mono text-sm font-bold lg:mx-auto" style={{ background: c, color: TIW.navy }}>
                <span className="sr-only">Stage {s.n} of 7 — </span>
                <span aria-hidden="true" className="absolute -top-1 -left-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold lg:static lg:hidden" style={{ background: TIW.white, color: TIW.navy }}>{s.n}</span>
                <StageGlyph n={s.n} />
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-bold leading-tight" style={{ color: TIW.white }}>
                  <span className="mr-1 font-mono text-[11px]" style={{ color: c }} aria-hidden="true">{String(s.n).padStart(2, "0")}</span>
                  {s.label}
                </p>
                <p className="mt-1 text-[11.5px] leading-snug" style={{ color: "rgba(255,255,255,.72)" }}>{s.detail}</p>
              </div>
              {i < ACQUISITION_FLOW.length - 1 ? (
                <svg viewBox="0 0 24 24" aria-hidden="true" className="absolute -right-3 top-1/2 hidden h-4 w-4 -translate-y-1/2 lg:block" style={{ color: TIW.ivory }} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M5 12h13m-5-5 5 5-5 5" /></svg>
              ) : null}
            </li>
          );
        })}
      </ol>
      <figcaption className="mt-4 text-center text-[11px]" style={{ color: "rgba(255,255,255,.55)" }}>
        The whole method in one line: tool-assisted verification in the middle, human honesty at both ends.
      </figcaption>
    </figure>
  );
}

/** Section 2 — visual workflow with actor chips (tool vs. you). */
export function ProcessTimeline() {
  return (
    <ol className="relative ml-3 space-y-4 border-l-2 pl-6" style={{ borderColor: "rgb(var(--accent))" }}>
      {PROCESS_STEPS.map((s) => (
        <li key={s.n} className="relative">
          <span aria-hidden="true" className="absolute -left-[2.35rem] top-0.5 flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold" style={{ background: s.actor === "tool" ? TIW.cyan : s.actor === "both" ? TIW.gold : "rgb(var(--primary))", color: TIW.navy }}>
            {s.n}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-[15px] font-semibold">{s.title}</h4>
            <span className="rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider" style={{ background: s.actor === "tool" ? "rgba(3,210,210,.15)" : s.actor === "both" ? "rgba(255,196,34,.18)" : "rgb(var(--muted))", color: s.actor === "tool" ? "#0A7C7C" : "rgb(var(--foreground))" }}>
              {s.actor === "tool" ? "SiteInsights" : s.actor === "both" ? "SiteInsights + you" : "You"}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Section 3 — niche comparison bars (illustrative ratings). */
export function NicheComparison() {
  return (
    <figure aria-label="Illustrative niche comparison on five criteria" className="min-w-0 overflow-x-auto">
      <table className="w-full min-w-[42rem] border-collapse text-[12.5px]">
        <caption className="sr-only">Illustrative niche ratings from 1 to 5 on five criteria: {NICHE_CRITERIA.join(", ")}</caption>
        <thead>
          <tr className="text-left font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
            <th scope="col" className="pb-2 pr-3 font-medium">Niche (illustrative 1–5 ratings)</th>
            {NICHE_CRITERIA.map((c) => <th key={c} scope="col" className="pb-2 pl-3 pr-1 font-medium">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {NICHES.map((n) => (
            <tr key={n.niche} className="border-t border-border/60 align-middle">
              <th scope="row" className="max-w-44 py-2.5 pr-3 text-left text-[13px] font-semibold leading-snug">{n.niche}<span className="block text-[11px] font-normal text-muted-foreground">{n.note}</span></th>
              {[n.quality, n.budget, n.value, n.access, n.deliverable].map((v, i) => (
                /* `relative` is a layout fix, not decoration: `.sr-only` is absolutely positioned
                   with no offsets, so its static position lands deep inside this 42rem-wide table
                   (x≈610px at mobile widths). Absolutely positioned boxes are clipped only along
                   their containing-block chain — the figure's overflow-x-auto never clipped them —
                   so their right edge propagated straight to the document scrollWidth, and mobile
                   browsers shrank the whole page to fit (~61%), leaving the blank right gutter a
                   user reported. Anchoring the containing block to the cell confines the 1px box
                   to the scrolled area and keeps the document at viewport width. */
                <td key={i} className="relative py-2.5 pl-3 pr-1">
                  <span className="sr-only">{v} of 5</span>
                  <span aria-hidden="true" className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
                    <span className="rounded-full" style={{ width: `${v * 20}%`, background: [TIW.orange, TIW.gold, TIW.violet, TIW.cyan, "rgb(var(--primary))"][i] }} />
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Section 4 — the weakness checklist infographic. */
export function WeaknessChecklist({ items }: { items: readonly { title: string }[] }) {
  return (
    <figure aria-label="Twelve weakness categories to check" className="min-w-0 rounded-2xl border border-border bg-card p-5 sm:p-6">
      <ol className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {items.map((w, i) => (
          <li key={w.title} className="flex items-start gap-2.5 border-b border-border/50 py-2 last:border-0 sm:last:border-b">
            <span aria-hidden="true" className="mt-0.5 flex h-[18px] w-[18px] flex-none items-center justify-center rounded border-2" style={{ borderColor: TIW.violet }}>
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke={TIW.violet} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4 10-10" /></svg>
            </span>
            <span className="text-[13.5px] font-medium leading-snug">
              <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
              {w.title}
            </span>
          </li>
        ))}
      </ol>
      <figcaption className="mt-1 text-[11.5px] text-muted-foreground">Details for every category follow below — what to inspect, how to verify, and what not to claim.</figcaption>
    </figure>
  );
}

/** Section 6 — priority matrix: confidence (x) × business impact (y). */
export function PriorityMatrix() {
  const W = 560, H = 380, P = 46;
  const iw = W - P * 1.5, ih = H - P * 1.7;
  const x = (v: number) => P + v * iw, y = (v: number) => P * 0.4 + ih - v * ih;
  return (
    <figure aria-label="Prioritization matrix: confidence in evidence versus business impact" className="min-w-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img">
        <rect x={x(0)} y={y(1)} width={iw} height={ih} rx="10" fill="rgb(var(--muted))" opacity="0.35" />
        {/* quadrant shading */}
        <rect x={x(0.5)} y={y(1)} width={iw / 2} height={ih / 2} fill={TIW.cyan} opacity="0.10" />
        <text x={x(0.5) + iw / 4} y={y(1) + 20} textAnchor="middle" fontSize="11" fontWeight="700" fill="rgb(var(--foreground))" opacity="0.55">PRIORITIZE HERE</text>
        <rect x={x(0)} y={y(0.5)} width={iw / 2} height={ih / 2} fill={TIW.gold} opacity="0.10" />
        <text x={x(0) + iw / 4} y={y(0.5) + ih / 2 - 8} textAnchor="middle" fontSize="11" fontWeight="700" fill="rgb(var(--foreground))" opacity="0.55">CHEAP TO FIX — VERIFY LATER</text>
        <rect x={x(0)} y={y(1)} width={iw / 2} height={ih / 2} fill={TIW.orange} opacity="0.08" />
        <text x={x(0) + iw / 4} y={y(1) + 20} textAnchor="middle" fontSize="11" fontWeight="700" fill="rgb(var(--foreground))" opacity="0.55">PROVE BEFORE YOU CLAIM</text>
        <rect x={x(0.5)} y={y(0.5)} width={iw / 2} height={ih / 2} fill="rgb(var(--muted))" opacity="0.5" />
        <text x={x(0.5) + iw / 4} y={y(0.5) + ih / 2 - 8} textAnchor="middle" fontSize="11" fontWeight="700" fill="rgb(var(--foreground))" opacity="0.55">LOW VALUE EVEN IF TRUE</text>
        <line x1={x(0.5)} y1={y(0)} x2={x(0.5)} y2={y(1)} stroke="rgb(var(--border))" strokeDasharray="4 4" />
        <line x1={x(0)} y1={y(0.5)} x2={x(1)} y2={y(0.5)} stroke="rgb(var(--border))" strokeDasharray="4 4" />
        {/* axes */}
        <line x1={x(0)} y1={y(1)} x2={x(0)} y2={y(0)} stroke="rgb(var(--foreground))" strokeWidth="1.5" />
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(0)} stroke="rgb(var(--foreground))" strokeWidth="1.5" />
        <text x={x(0.5)} y={H - 14} textAnchor="middle" fontSize="12" fontWeight="600" fill="rgb(var(--foreground))">Confidence in the evidence →</text>
        <text x={14} y={y(0.5)} textAnchor="middle" fontSize="12" fontWeight="600" fill="rgb(var(--foreground))" transform={`rotate(-90 14 ${y(0.5)})`}>Likely business impact →</text>
        {PRIORITY_EXAMPLES.map((p, i) => (
          <g key={p.finding}>
            <circle cx={x(p.x)} cy={y(p.y)} r="10" fill={[TIW.violet, TIW.cyan, TIW.gold, TIW.orange, "#8A2A52", "rgb(var(--primary))"][i]} />
            <text x={x(p.x)} y={y(p.y) + 1} textAnchor="middle" dominantBaseline="middle" fontSize="10" fontWeight="800" fill={TIW.white}>{String.fromCharCode(65 + i)}</text>
          </g>
        ))}
      </svg>
      <figcaption className="mt-2">
        <ol className="grid gap-x-5 gap-y-1 text-[12px] text-secondary sm:grid-cols-2">
          {PRIORITY_EXAMPLES.map((p, i) => (
            <li key={p.finding} className="flex gap-2">
              <span aria-hidden="true" className="mt-1 inline-block h-2.5 w-2.5 flex-none rounded-full" style={{ background: [TIW.violet, TIW.cyan, TIW.gold, TIW.orange, "#8A2A52", "rgb(var(--primary))"][i] }} />
              <span><strong>{String.fromCharCode(65 + i)} — {p.finding}.</strong> {p.relevance}; {p.priority}.</span>
            </li>
          ))}
        </ol>
      </figcaption>
    </figure>
  );
}

/** Section 7 — the nine-part report structure as a document schematic. */
export function ReportStructureVisual({ parts }: { parts: readonly { part: string; body: string }[] }) {
  return (
    <figure aria-label="Recommended audit report structure in nine parts" className="min-w-0">
      <ol className="mx-auto max-w-md space-y-1.5">
        {parts.map((r, i) => {
          const depth = i / (parts.length - 1);
          const width = 100 - depth * 24;
          return (
            <li key={r.part} className="mx-auto rounded-lg border px-3.5 py-1.5 text-center" style={{ width: `${width}%`, minWidth: "62%", borderColor: "rgba(102,34,73,.35)", background: depth < 0.4 ? "rgba(3,210,210,.10)" : depth < 0.7 ? "rgba(255,196,34,.12)" : "rgba(102,34,73,.10)" }}>
              <span className="block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
              <span className="text-[13px] font-semibold">{r.part}</span>
            </li>
          );
        })}
      </ol>
      <figcaption className="mt-2 text-center text-[11.5px] text-muted-foreground">Dense at the top, lean at the bottom — most owners read the summary and the price, skim the rest.</figcaption>
    </figure>
  );
}

/** Section 9 — cold-call conversation flowchart. */
const callFlowTone = {
  cyan: { background: "rgba(3,210,210,.14)", borderColor: "rgba(3,130,130,.4)" },
  gold: { background: "rgba(255,196,34,.16)", borderColor: "rgba(201,138,18,.45)" },
  violet: { background: "rgba(102,34,73,.10)", borderColor: "rgba(102,34,73,.4)" },
  plain: { background: "rgb(var(--card))", borderColor: "rgb(var(--border))" },
} as const;

function CallFlowBox({ children, tone }: { children: ReactNode; tone: keyof typeof callFlowTone }) {
  return (
    <div className="rounded-lg border px-3 py-2 text-center text-[12.5px] font-medium leading-snug shadow-sm" style={callFlowTone[tone]}>
      {children}
    </div>
  );
}

function CallFlowArrow() {
  return (
    <div aria-hidden="true" className="flex justify-center py-1">
      <svg viewBox="0 0 24 24" className="h-4 w-4 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 4v14m0 0 5-5m-5 5-5-5" /></svg>
    </div>
  );
}

export function CallFlow() {
  return (
    <div className="min-w-0" role="group" aria-label="Cold-call conversation flow">
      <CallFlowBox tone="cyan">You: name + who you are + “a moment?”</CallFlowBox>
      <CallFlowArrow />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <CallFlowBox tone="plain">Gatekeeper / busy owner</CallFlowBox>
          <CallFlowArrow />
          <CallFlowBox tone="plain">Ask permission to send two short paragraphs</CallFlowBox>
          <CallFlowArrow />
          <CallFlowBox tone="gold">Send the concise email → follow up once</CallFlowBox>
        </div>
        <div>
          <CallFlowBox tone="plain">Owner has a moment</CallFlowBox>
          <CallFlowArrow />
          <CallFlowBox tone="violet">State ONE verified observation in plain words</CallFlowBox>
          <CallFlowArrow />
          <CallFlowBox tone="gold">Permission to send the report → agree the next step</CallFlowBox>
        </div>
      </div>
      <CallFlowArrow />
      <CallFlowBox tone="plain">“No” or opt-out → thank them, log it, never contact again</CallFlowBox>
    </div>
  );
}

/** Section 13 — pipeline funnel. */
export function FunnelDiagram() {
  return (
    <figure aria-label="Lead pipeline funnel with ten stages" className="min-w-0">
      <ol className="space-y-1">
        {FUNNEL_STAGES.map((s, i) => (
          <li key={s.stage} className="flex items-center gap-3">
            <span className="w-[4.6rem] flex-none text-right font-mono text-[10px] uppercase leading-tight text-muted-foreground sm:w-36 sm:text-[11px]">{s.stage}</span>
            <span className="relative h-7 min-w-0 flex-1 overflow-hidden rounded-md bg-muted">
              <span className="flex h-full items-center rounded-md pl-2 text-[10.5px] font-semibold" style={{ width: `${s.width}%`, minWidth: "1.75rem", background: `linear-gradient(90deg, ${["#0E436B", "#17547f", "#216693", "#2b78a7", "#3d8ab2", "#5d9fbe", "#C98A12", "#E0A22E", TIW.gold, TIW.orange][i]}, transparent 140%)`, color: i < 6 ? TIW.white : TIW.navy }}>
                <span className="hidden sm:inline">{s.hint}</span>
              </span>
            </span>
            <span className="w-5 flex-none text-right text-[10px] text-muted-foreground">{i + 1}</span>
          </li>
        ))}
      </ol>
      <figcaption className="mt-2 text-[11.5px] text-muted-foreground">Shapes at a glance: you verify more than you contact; you contact more than you pitch.</figcaption>
    </figure>
  );
}

/** Section 14 — seven-day timeline. */
export function SevenDayTimeline() {
  return (
    <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
      {SEVEN_DAYS.map((d) => (
        <li key={d.day} className="relative rounded-xl border border-border bg-card p-3.5 pt-5">
          <span aria-hidden="true" className="absolute -top-2.5 left-3.5 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold" style={{ background: d.day % 2 ? TIW.violet : TIW.gold, color: d.day % 2 ? TIW.white : TIW.navy }}>
            DAY {d.day}
          </span>
          <h4 className="text-[13.5px] font-bold leading-snug">{d.title}</h4>
          <p className="mt-1 text-[11.5px] leading-snug text-secondary">{d.detail}</p>
        </li>
      ))}
    </ol>
  );
}
