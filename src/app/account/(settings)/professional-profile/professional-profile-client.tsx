"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { InlineError } from "@/components/load-error";
import { SettingsSkeleton } from "@/components/skeletons";
import { Alert, Button, Card, CardHeader, Input, PageHeader, Spinner } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { CATEGORIES, CATEGORY_LABELS } from "@/lib/audit/types";
import { type ProfessionalData, type ProfessionalProfile, type ProfessionalService, type ProfessionalPortfolioItem } from "@/lib/professional/types";
import { MAX_LOGO_BYTES, MAX_LOGO_DIMENSION, MAX_LOGO_PIXELS } from "@/lib/professional/logo-limits";
import { addBrandColor, brandColorIssues, normalizeHexColor, removeBrandColor, updateBrandColor } from "@/lib/professional/brand-colors";
import { parseLogoDimensions } from "@/lib/professional/logo-client";

const PUBLIC_FIELDS: Array<{ id: ProfessionalProfile["publicFields"][number]; label: string }> = [
  { id: "profileType", label: "Freelancer or agency type" },
  { id: "professionalName", label: "Professional name" },
  { id: "businessName", label: "Agency or business name (agency profiles)" },
  { id: "jobTitle", label: "Role or title" },
  { id: "headline", label: "Headline" },
  { id: "biography", label: "Short bio" },
  { id: "websiteUrl", label: "Website link" },
  { id: "contactEmail", label: "Contact email" },
  { id: "contactPhone", label: "Contact phone" },
  { id: "location", label: "Location" },
  { id: "brandColors", label: "Brand colors" },
  { id: "logo", label: "Logo" },
];

const labelClass = "block text-sm font-medium";
const textareaClass = "mt-1 w-full rounded-md border border-charcoal/20 bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring";
const toggle = <T extends string>(list: T[], value: T) => list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

type LogoInfo = { fileName: string | null; bytes: number; width: number | null; height: number | null };

function dataUrlByteLength(dataUrl: string): number {
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
}

function formatFileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KiB`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The logo could not be read."));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("The logo could not be read."));
    reader.readAsDataURL(file);
  });
}

export function ProfessionalProfileClient() {
  const [data, setData] = useState<ProfessionalData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadBusy, setLoadBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [logoInfo, setLogoInfo] = useState<LogoInfo | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoDragging, setLogoDragging] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoadBusy(true);
    api<{ professional: ProfessionalData }>("/api/account/professional-profile")
      .then((r) => {
        setData(r.professional);
        const logo = r.professional.profile.logoDataUrl;
        setLogoInfo(logo ? { fileName: null, bytes: dataUrlByteLength(logo), width: null, height: null } : null);
        setLogoError(null);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoadBusy(false));
  }, []);
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t); }, [load]);

  const updateProfile = (patch: Partial<ProfessionalProfile>) => setData((d) => d ? { ...d, profile: { ...d.profile, ...patch } } : d);
  const updateService = (id: string, patch: Partial<ProfessionalService>) => setData((d) => d ? { ...d, services: d.services.map((s) => s.id === id ? { ...s, ...patch } : s) } : d);
  const updatePortfolio = (id: string, patch: Partial<ProfessionalPortfolioItem>) => setData((d) => d ? { ...d, portfolio: d.portfolio.map((p) => p.id === id ? { ...p, ...patch } : p) } : d);

  const save = async () => {
    if (!data) return;
    const colorIssues = brandColorIssues(data.profile.brandColors);
    if (data.profile.brandColors.length > 10 || colorIssues.some((issue) => issue.name || issue.value)) {
      setMessage({ tone: "error", text: "Fix the brand color names and six-digit hex values before saving." });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const r = await api<{ professional: ProfessionalData }>("/api/account/professional-profile", { method: "PUT", json: data });
      setData(r.professional);
      setMessage({ tone: "success", text: "Professional profile, services and publication preferences saved." });
    } catch (e) {
      setMessage({ tone: "error", text: (e as ApiClientError).message });
    } finally {
      setSaving(false);
    }
  };

  const logoSelected = async (file: File | undefined) => {
    if (!file || !data || saving || logoBusy) return;
    setLogoError(null);
    setLogoBusy(true);
    try {
      if (file.type !== "image/png" && file.type !== "image/jpeg") {
        throw new Error("Choose a PNG or JPEG image. SVG and other image formats are not accepted.");
      }
      if (file.size > MAX_LOGO_BYTES) {
        throw new Error("The logo must be 1 MiB (1,048,576 bytes) or smaller. Resize or compress it, then choose it again.");
      }
      const header = new Uint8Array(await file.arrayBuffer());
      const parsedDimensions = parseLogoDimensions(header, file.type);
      if (!parsedDimensions) {
        throw new Error("This image is invalid or exceeds 2,048 pixels on either side or 2 million pixels total.");
      }
      const bitmap = await createImageBitmap(file);
      const { width, height } = bitmap;
      bitmap.close();
      const validDimensions = width > 0 && height > 0 && width <= MAX_LOGO_DIMENSION && height <= MAX_LOGO_DIMENSION && width * height <= MAX_LOGO_PIXELS;
      if (!validDimensions) {
        throw new Error("Logo images must be no larger than 2,048 pixels on either side and 2 million pixels total.");
      }
      const dataUrl = await readFileAsDataUrl(file);
      updateProfile({ logoDataUrl: dataUrl });
      setLogoInfo({ fileName: file.name || "Selected logo", bytes: file.size, width, height });
      setMessage(null);
    } catch (error) {
      setLogoError(error instanceof Error ? error.message : "The selected file could not be validated.");
    } finally {
      setLogoBusy(false);
    }
  };

  if (error) return <Card><InlineError error={error} what="your professional profile" onRetry={load} busy={loadBusy} /></Card>;
  if (!data) return <SettingsSkeleton label="Loading professional profile" embedded />;
  const { profile } = data;
  const profileBrandColorIssues = brandColorIssues(profile.brandColors);

  return (
    <div className="space-y-6">
      <PageHeader
        title={profile.onboardingCompleted ? "Professional profile" : "Let's set up your professional profile"}
        description={profile.onboardingCompleted ? "Manage your freelancer or agency identity, services and portfolio." : "Create a professional identity for reports and client work. Your details stay private unless you explicitly choose to publish them."}
      />
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {!profile.onboardingCompleted ? (
        <Alert tone="info" title="Start with the details that identify your work">
          To finish the basics, add your professional name and headline; agency profiles also need a business name. A role or title is optional. Add only the services, contact details, branding and portfolio items you want. Everything stays private unless you explicitly opt it into report publication. Save your draft whenever you like and return later.
        </Alert>
      ) : null}

      <fieldset disabled={saving} aria-busy={saving} className="m-0 min-w-0 space-y-6 border-0 p-0">
      <Card>
        <CardHeader title="Your professional details" description="These details are private to your account until you enable individual fields below." />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <fieldset className="sm:col-span-2" aria-describedby="profile-type-help">
            <legend className={labelClass}>Profile type</legend>
            <p id="profile-type-help" className="mt-1 text-xs font-normal text-muted-foreground">Changing type preserves your profile fields, services, portfolio, and publication choices.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="relative">
                <input id="freelancer-profile" className="peer sr-only" type="radio" name="profileType" value="freelancer" checked={profile.profileType === "freelancer"} onChange={() => updateProfile({ profileType: "freelancer" })} />
                <label htmlFor="freelancer-profile" className="block min-h-full cursor-pointer rounded-xl border border-border bg-card/80 p-4 transition-[border-color,background-color,box-shadow] duration-150 hover:border-primary/50 peer-checked:border-primary peer-checked:bg-primary/5 peer-checked:shadow-soft peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background peer-disabled:cursor-not-allowed peer-disabled:opacity-60">
                  <span className="font-semibold">Freelancer</span>
                  <span className="mt-1 block pl-6 text-xs font-normal text-muted-foreground">An independent professional profile.</span>
                </label>
              </div>
              <div className="relative">
                <input id="agency-profile" className="peer sr-only" type="radio" name="profileType" value="agency" checked={profile.profileType === "agency"} onChange={() => updateProfile({ profileType: "agency" })} />
                <label htmlFor="agency-profile" className="block min-h-full cursor-pointer rounded-xl border border-border bg-card/80 p-4 transition-[border-color,background-color,box-shadow] duration-150 hover:border-primary/50 peer-checked:border-primary peer-checked:bg-primary/5 peer-checked:shadow-soft peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background peer-disabled:cursor-not-allowed peer-disabled:opacity-60">
                  <span className="font-semibold">Agency</span>
                  <span className="mt-1 block pl-6 text-xs font-normal text-muted-foreground">A studio or agency, with business details shown only for this type.</span>
                </label>
              </div>
            </div>
          </fieldset>
          <label className={labelClass}>Professional name
            <Input className="mt-1" value={profile.professionalName} maxLength={100} onChange={(e) => updateProfile({ professionalName: e.target.value })} placeholder="Your name" />
          </label>
          {profile.profileType === "agency" ? <label className={labelClass}>Agency or business name
            <Input className="mt-1" value={profile.businessName} maxLength={120} onChange={(e) => updateProfile({ businessName: e.target.value })} placeholder="Studio or company name" />
          </label> : profile.businessName ? <p className="self-center text-xs text-muted-foreground sm:col-span-2">Your saved agency name is kept privately and will reappear if you switch this profile back to agency.</p> : null}
          <label className={labelClass}>Role or title
            <Input className="mt-1" value={profile.jobTitle} maxLength={100} onChange={(e) => updateProfile({ jobTitle: e.target.value })} placeholder="Web designer, SEO consultant…" />
          </label>
          <label className={`${labelClass} sm:col-span-2`}>Headline
            <Input className="mt-1" value={profile.headline} maxLength={180} onChange={(e) => updateProfile({ headline: e.target.value })} placeholder="A clear, professional one-line introduction" />
          </label>
          <label className={`${labelClass} sm:col-span-2`}>About you or your agency
            <textarea className={textareaClass} value={profile.biography} maxLength={2000} rows={5} onChange={(e) => updateProfile({ biography: e.target.value })} placeholder="Describe your experience and the kind of work you do. Avoid unverifiable guarantees." />
            <span className="mt-1 block text-xs font-normal text-muted-foreground">Up to 2,000 characters. This is displayed as plain text, never as HTML.</span>
          </label>
          <label className={labelClass}>Website
            <Input type="url" className="mt-1" value={profile.websiteUrl} maxLength={2048} onChange={(e) => updateProfile({ websiteUrl: e.target.value })} placeholder="https://example.com" />
          </label>
          <label className={labelClass}>Location (optional)
            <Input className="mt-1" value={profile.location} maxLength={120} onChange={(e) => updateProfile({ location: e.target.value })} placeholder="City, country or remote" />
          </label>
          <label className={labelClass}>Contact email
            <Input type="email" className="mt-1" value={profile.contactEmail} maxLength={254} onChange={(e) => updateProfile({ contactEmail: e.target.value })} placeholder="hello@example.com" />
          </label>
          <label className={labelClass}>Contact phone
            <Input type="tel" className="mt-1" value={profile.contactPhone} maxLength={50} onChange={(e) => updateProfile({ contactPhone: e.target.value })} placeholder="+1 555 0100" />
          </label>
        </div>
      </Card>

      <Card>
        <CardHeader title="Report publication controls" description="Only checked fields are copied into new, versioned client-report snapshots. Existing links keep their original snapshot until revoked or expired." />
        <div className="grid gap-3 p-5 sm:grid-cols-2">
          {PUBLIC_FIELDS.filter((f) => f.id !== "businessName" || profile.profileType === "agency").map((f) => (
            <label key={f.id} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={profile.publicFields.includes(f.id)} disabled={saving} onChange={() => updateProfile({ publicFields: toggle(profile.publicFields, f.id) })} />
              <span>{f.label}<span className="block text-xs text-muted-foreground">{f.id === "brandColors" || f.id === "logo" ? "Included in the report's visual identity." : "Visible to anyone with a report link."}</span></span>
            </label>
          ))}
          <p className="text-xs text-muted-foreground sm:col-span-2">New report links are read-only, expire, and can be revoked. Contact details are never pulled from your account email automatically.</p>
        </div>
      </Card>

      <Card>
        <CardHeader title="Branding" description="Create a named palette and add a private logo for your client reports. Branding is only published when you explicitly select it above." />
        <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[1.15fr_0.85fr]">
          <section className="min-w-0 rounded-xl border border-border bg-background p-4 sm:p-5" aria-labelledby="brand-colors-heading">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 id="brand-colors-heading" className="text-sm font-semibold">Brand colors</h3>
                <p className="mt-1 text-xs text-muted-foreground">Name each color, enter a six-digit hex value, or use the picker. Up to 10 distinct values.</p>
              </div>
              <span className="rounded-md border bg-card px-2 py-1 text-xs font-medium text-muted-foreground">{profile.brandColors.length} / 10</span>
            </div>
            <div className="mt-4 space-y-3">
              {profile.brandColors.map((color, index) => {
                const issues = profileBrandColorIssues[index] ?? {};
                const colorForPicker = normalizeHexColor(color.value) ?? "#000000";
                const errorId = `brand-color-error-${index}`;
                return (
                  <div key={index} className="rounded-lg border border-border bg-card p-3">
                    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-3 sm:grid-cols-[auto_minmax(0,1fr)_minmax(8rem,0.65fr)_auto]">
                      <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                        <span className="sr-only">Picker for {color.name || `color ${index + 1}`}</span>
                        <input type="color" aria-label={`Color picker for ${color.name || `color ${index + 1}`}`} value={colorForPicker} disabled={saving} onChange={(e) => updateProfile({ brandColors: updateBrandColor(profile.brandColors, index, { value: e.target.value.toUpperCase() }) })} className="h-11 w-12 cursor-pointer rounded-md border border-border bg-card p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60" />
                      </label>
                      <label className="min-w-0 text-xs font-medium">Color name
                        <Input className="mt-1" value={color.name} maxLength={40} aria-invalid={!!issues.name} aria-describedby={issues.name || issues.value ? errorId : undefined} disabled={saving} onChange={(e) => updateProfile({ brandColors: updateBrandColor(profile.brandColors, index, { name: e.target.value }) })} placeholder="Primary Purple" />
                      </label>
                      <label className="col-span-2 min-w-0 text-xs font-medium sm:col-span-1">Hex value
                        <Input className="mt-1 font-mono uppercase" value={color.value} maxLength={7} spellCheck={false} autoCapitalize="characters" aria-invalid={!!issues.value} aria-describedby={issues.name || issues.value ? errorId : undefined} disabled={saving} onChange={(e) => updateProfile({ brandColors: updateBrandColor(profile.brandColors, index, { value: e.target.value }) })} onBlur={() => {
                          const normalized = normalizeHexColor(color.value);
                          if (normalized && normalized !== color.value) updateProfile({ brandColors: updateBrandColor(profile.brandColors, index, { value: normalized }) });
                        }} placeholder="#1B1931" />
                      </label>
                      <Button type="button" size="sm" variant="ghost" className="col-span-2 justify-self-end text-danger sm:col-span-1" aria-label={`Remove ${color.name || `color ${index + 1}`}`} disabled={saving} onClick={() => updateProfile({ brandColors: removeBrandColor(profile.brandColors, index) })}>Remove</Button>
                    </div>
                    {issues.name || issues.value ? <p id={errorId} role="status" aria-live="polite" className="mt-2 text-xs text-danger">{[issues.name, issues.value].filter(Boolean).join(" ")}</p> : null}
                  </div>
                );
              })}
              {!profile.brandColors.length ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No colors yet. Add a named color to start your palette.</p> : null}
              <Button type="button" variant="outline" size="sm" disabled={saving || profile.brandColors.length >= 10} onClick={() => updateProfile({ brandColors: addBrandColor(profile.brandColors) })}>Add color</Button>
            </div>
          </section>

          <section className="min-w-0 rounded-xl border border-border bg-background p-4 sm:p-5" aria-labelledby="brand-logo-heading" aria-busy={logoBusy}>
            <div>
              <h3 id="brand-logo-heading" className="text-sm font-semibold">Logo</h3>
              <p className="mt-1 text-xs text-muted-foreground">A PNG or JPEG is stored in your private profile. It is embedded in report snapshots only when you enable the Logo publication option.</p>
            </div>
            <div
              className={`mt-4 rounded-xl border-2 border-dashed p-4 transition-colors ${logoDragging ? "border-primary bg-primary/5" : "border-border bg-card"}`}
              onDragEnter={(event) => { event.preventDefault(); if (!saving && !logoBusy) setLogoDragging(true); }}
              onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; if (!saving && !logoBusy) setLogoDragging(true); }}
              onDragLeave={(event) => { const next = event.relatedTarget; if (!(next instanceof Node) || !event.currentTarget.contains(next)) setLogoDragging(false); }}
              onDrop={(event) => { event.preventDefault(); setLogoDragging(false); if (!saving && !logoBusy) void logoSelected(event.dataTransfer.files?.[0]); }}
            >
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{logoDragging ? "Drop to upload" : profile.logoDataUrl ? "Logo ready" : "Drag and drop a logo"}</p>
                  <p className="mt-1 text-xs text-muted-foreground">or choose a file from your device</p>
                </div>
              </div>
              <input ref={logoInput} className="sr-only" type="file" accept="image/png,image/jpeg" aria-label="Choose a PNG or JPEG logo" tabIndex={-1} disabled={saving || logoBusy} onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; void logoSelected(file); }} />
              <Button type="button" className="mt-4 w-full sm:w-auto" disabled={saving || logoBusy} onClick={() => logoInput.current?.click()}>
                {logoBusy ? <><Spinner /> Reading logo…</> : profile.logoDataUrl ? "Replace logo" : "Upload logo"}
              </Button>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">PNG or JPEG only · Maximum 1 MiB (1,048,576 bytes) · 2,048 pixels per side · 2 million pixels total · SVG is rejected.</p>
              {logoError ? <p role="alert" className="mt-3 rounded-md border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">{logoError}</p> : null}
            </div>
            {profile.logoDataUrl ? (
              <div className="mt-4 flex min-w-0 items-center gap-3 rounded-lg border bg-card p-3">
                <Image src={profile.logoDataUrl} alt="Professional profile logo preview" width={80} height={80} unoptimized onLoad={(event) => {
                  const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
                  setLogoInfo((current) => current ? { ...current, width, height } : current);
                }} className="h-16 w-16 shrink-0 rounded-md border bg-white object-contain p-1" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{logoInfo?.fileName || "Saved logo"}</p>
                  {logoInfo ? <p className="mt-0.5 text-xs text-muted-foreground">{formatFileSize(logoInfo.bytes)}{logoInfo.width && logoInfo.height ? ` · ${logoInfo.width} × ${logoInfo.height} px` : ""}</p> : null}
                </div>
                <Button type="button" size="sm" variant="ghost" className="text-danger" disabled={saving} onClick={() => { updateProfile({ logoDataUrl: null }); setLogoInfo(null); setLogoError(null); }}>Remove logo</Button>
              </div>
            ) : <p className="mt-4 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No logo selected. Your reports stay unbranded until you add one and opt in to publishing it.</p>}
          </section>
        </div>
      </Card>

      <Card>
        <CardHeader title="Services" description="Choose the audit categories your services address. Matching is deterministic and based only on open, verified findings from each audit." action={<Button type="button" size="sm" variant="outline" disabled={data.services.length >= 20} onClick={() => setData({ ...data, services: [...data.services, { id: crypto.randomUUID(), title: "", description: "", categories: [], keywords: [], isPublic: false, sortOrder: data.services.length }] })}>Add service</Button>} />
        <div className="space-y-4 p-5">
          {!data.services.length ? <p className="text-sm text-muted-foreground">No services yet. Add one to enable audit-to-service matching.</p> : null}
          {data.services.map((service, index) => (
            <section key={service.id} className="rounded-md border p-4" aria-label={`Service ${index + 1}`}>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={labelClass}>Service name
                  <Input className="mt-1" value={service.title} maxLength={100} onChange={(e) => updateService(service.id, { title: e.target.value })} placeholder="Technical SEO improvements" />
                </label>
                <label className={labelClass}>Matching keywords (optional)
                  <Input className="mt-1" value={service.keywords.join(", ")} maxLength={420} onChange={(e) => updateService(service.id, { keywords: e.target.value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 10) })} placeholder="canonical, title tag" />
                </label>
                <label className={`${labelClass} sm:col-span-2`}>Service description
                  <textarea className={textareaClass} value={service.description} maxLength={1500} rows={3} onChange={(e) => updateService(service.id, { description: e.target.value })} placeholder="Describe the work you offer." />
                </label>
                <fieldset className="sm:col-span-2">
                  <legend className="text-sm font-medium">Audit categories this service can address</legend>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {CATEGORIES.map((category) => <label key={category} className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={service.categories.includes(category)} onChange={() => updateService(service.id, { categories: toggle(service.categories, category) })} />{CATEGORY_LABELS[category]}</label>)}
                  </div>
                </fieldset>
                <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" className="mt-1 h-4 w-4" checked={service.isPublic} onChange={(e) => updateService(service.id, { isPublic: e.target.checked })} /><span>Publish this service in client reports<span className="block text-xs text-muted-foreground">It appears only when its selected category or keywords match verified findings.</span></span></label>
              </div>
              <div className="mt-3 flex justify-end"><Button type="button" size="sm" variant="ghost" className="text-danger" onClick={() => setData({ ...data, services: data.services.filter((s) => s.id !== service.id), portfolio: data.portfolio.map((p) => ({ ...p, serviceIds: p.serviceIds.filter((id) => id !== service.id) })) })}>Remove service</Button></div>
            </section>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Portfolio" description="Add project links and connect each item to a service or audit category. Only relevant, published items appear in a client report; links are text-only, not embedded HTML or screenshots." action={<Button type="button" size="sm" variant="outline" disabled={data.portfolio.length >= 25} onClick={() => setData({ ...data, portfolio: [...data.portfolio, { id: crypto.randomUUID(), title: "", projectUrl: "", description: "", serviceIds: [], categories: [], isPublic: false, sortOrder: data.portfolio.length }] })}>Add project</Button>} />
        <div className="space-y-4 p-5">
          {!data.portfolio.length ? <p className="text-sm text-muted-foreground">No portfolio items yet. Add a validated project URL and link it to relevant services.</p> : null}
          {data.portfolio.map((item, index) => (
            <section key={item.id} className="rounded-md border p-4" aria-label={`Portfolio project ${index + 1}`}>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={labelClass}>Project name
                  <Input className="mt-1" value={item.title} maxLength={120} onChange={(e) => updatePortfolio(item.id, { title: e.target.value })} placeholder="Project title" />
                </label>
                <label className={labelClass}>Project URL
                  <Input type="url" className="mt-1" value={item.projectUrl} maxLength={2048} onChange={(e) => updatePortfolio(item.id, { projectUrl: e.target.value })} placeholder="https://example.com/case-study" />
                </label>
                <label className={`${labelClass} sm:col-span-2`}>Short description
                  <textarea className={textareaClass} value={item.description} maxLength={1200} rows={3} onChange={(e) => updatePortfolio(item.id, { description: e.target.value })} placeholder="Describe the work without adding unsupported results." />
                </label>
                {data.services.length ? <fieldset className="sm:col-span-2"><legend className="text-sm font-medium">Related services</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">{data.services.map((service) => <label key={service.id} className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={item.serviceIds.includes(service.id)} onChange={() => updatePortfolio(item.id, { serviceIds: toggle(item.serviceIds, service.id) })} />{service.title || "Untitled service"}</label>)}</div></fieldset> : null}
                <fieldset className="sm:col-span-2"><legend className="text-sm font-medium">Relevant audit categories</legend><div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{CATEGORIES.map((category) => <label key={category} className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={item.categories.includes(category)} onChange={() => updatePortfolio(item.id, { categories: toggle(item.categories, category) })} />{CATEGORY_LABELS[category]}</label>)}</div></fieldset>
                <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" className="mt-1 h-4 w-4" checked={item.isPublic} onChange={(e) => updatePortfolio(item.id, { isPublic: e.target.checked })} /><span>Publish this project when it is relevant to the matched findings</span></label>
              </div>
              <div className="mt-3 flex justify-end"><Button type="button" size="sm" variant="ghost" className="text-danger" onClick={() => setData({ ...data, portfolio: data.portfolio.filter((p) => p.id !== item.id) })}>Remove project</Button></div>
            </section>
          ))}
        </div>
      </Card>
      </fieldset>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">Profile fields and materials are plain text or validated URLs. Report links capture the selected public data at creation time.</p>
        <Button type="button" onClick={() => void save()} disabled={saving || logoBusy}>{saving ? <><Spinner /> Saving…</> : "Save professional profile"}</Button>
      </div>
    </div>
  );
}
