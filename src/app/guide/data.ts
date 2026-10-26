/**
 * Guide content model for /guide — pure data, server-safe, unit-testable.
 * No invented platform capabilities, market statistics, or conversion promises:
 * every SiteInsight feature named here exists in the repository (features page,
 * scans, reports, share links, prospects, batch audits), and every rating is
 * labelled illustrative where it is not a measured fact.
 */

export const GUIDE_PATH = "/guide";

export interface TocItem { id: string; n: string; title: string }

export const GUIDE_TOC: readonly TocItem[] = [
  { id: "what-is-siteinsight", n: "01", title: "What is SiteInsights?" },
  { id: "how-it-works", n: "02", title: "How the process works" },
  { id: "choose-a-niche", n: "03", title: "Choose a profitable niche" },
  { id: "find-weak-websites", n: "04", title: "Find weak websites" },
  { id: "audit-a-prospect", n: "05", title: "Audit a prospect with SiteInsights" },
  { id: "prioritize-findings", n: "06", title: "Prioritize by business relevance" },
  { id: "professional-report", n: "07", title: "Create a professional report" },
  { id: "professional-profiles", n: "08", title: "Set up professional profiles" },
  { id: "cold-calling", n: "09", title: "Cold calling, step by step" },
  { id: "opening-hooks", n: "10", title: "Opening hooks that earn attention" },
  { id: "after-the-call", n: "11", title: "Send the report after the call" },
  { id: "objections", n: "12", title: "Handle objections, sell the fix" },
  { id: "follow-up-system", n: "13", title: "Follow-up system and lead tracking" },
  { id: "seven-day-plan", n: "14", title: "A realistic seven-day action plan" },
  { id: "mistakes-checklist", n: "15", title: "Common mistakes and final checklist" },
] as const;

/* -------------------------------- section 1 infographic ------------------- */

export interface FlowStage { n: number; label: string; detail: string }

export const ACQUISITION_FLOW: readonly FlowStage[] = [
  { n: 1, label: "Find a prospect", detail: "A real business with a public website you can inspect." },
  { n: 2, label: "Inspect the website", detail: "Look at it the way a customer would — on mobile too." },
  { n: 3, label: "Validate a problem", detail: "Reproduce it; keep only what you can prove." },
  { n: 4, label: "Generate an evidence report", detail: "Use a SiteInsights audit: findings with URLs and evidence." },
  { n: 5, label: "Contact the owner", detail: "Brief, respectful, one specific observation." },
  { n: 6, label: "Discuss solutions", detail: "Listen first; explain the fix in plain language." },
  { n: 7, label: "Win the project", detail: "Agree on one small, well-defined first step." },
] as const;

/* -------------------------------- section 2 steps -------------------------- */

export interface ProcessStep { n: number; title: string; purpose: string; output: string; mistakes: string[]; actor: "tool" | "you" | "both" }

export const PROCESS_STEPS: readonly ProcessStep[] = [
  { n: 1, title: "Select a niche", actor: "you", purpose: "Focus beats volume: one market you understand.", output: "A one-sentence niche definition, e.g. \"independent dental clinics in my region\".", mistakes: ["Choosing everyone as the niche", "Picking a market you can't deliver for"] },
  { n: 2, title: "Find businesses with public websites", actor: "you", purpose: "Build a list from public sources only.", output: "10–20 candidate websites with public contact pages.", mistakes: ["Harvesting personal data against platform terms", "Listing businesses you know nothing about"] },
  { n: 3, title: "Shortlist potential weaknesses", actor: "you", purpose: "Spend audit effort where a real issue likely exists.", output: "A shortlist of 5–10 sites with a visible reason to look closer.", mistakes: ["Judging by vibes alone", "Confusing old design with broken function"] },
  { n: 4, title: "Audit each shortlisted website", actor: "tool", purpose: "Let the crawler and checks do the repetitive inspection.", output: "A SiteInsights audit with findings, affected URLs and evidence per finding.", mistakes: ["Auditing sites without an apparent need", "Ignoring the audit's stated limitations"] },
  { n: 5, title: "Manually verify the key findings", actor: "you", purpose: "Only verified findings may be presented to an owner.", output: "1–3 reproducible findings, each with proof (URL, screenshot, steps).", mistakes: ["Forwarding raw scanner output unchecked", "Claiming revenue loss you cannot evidence"] },
  { n: 6, title: "Prepare the report", actor: "both", purpose: "Turn data into something an owner can act on.", output: "SiteInsights PDF report or a read-only client report link.", mistakes: ["Sending dozens of low-value warnings", "Hiding that findings were tool-assisted"] },
  { n: 7, title: "Identify the right contact", actor: "you", purpose: "Owner for small firms; office/marketing manager otherwise.", output: "A name and a published business phone or email.", mistakes: ["Emailing scraped personal addresses", "Guessing roles from a logo"] },
  { n: 8, title: "Make professional first contact", actor: "you", purpose: "Earn 30 seconds of attention with one fact.", output: "A short call or message mentioning one verified observation.", mistakes: ["Openers about \"your SEO\"", "Fear-based claims"] },
  { n: 9, title: "Send the report when appropriate", actor: "you", purpose: "Deliver the promised evidence, nothing more.", output: "A concise email with the report link or PDF attached.", mistakes: ["Attaching to people who declined", "Walls of text"] },
  { n: 10, title: "Follow up respectfully", actor: "you", purpose: "One reminder, then professional silence.", output: "At most one or two polite follow-ups, spaced days apart.", mistakes: ["Daily pings", "Guilt-tripping non-responders"] },
  { n: 11, title: "Offer the solution and agree a next step", actor: "you", purpose: "Convert interest into one concrete, small project.", output: "A written mini-proposal: fix(es), price or estimate, timeframe.", mistakes: ["Selling everything at once", "Promising rankings or revenue"] },
] as const;

/* -------------------------------- section 3 niches ------------------------- */

export interface NicheRow { niche: string; quality: number; budget: number; value: number; access: number; deliverable: number; note: string }

/** Illustrative 1–5 ratings to demonstrate the evaluation method — NOT market data. */
export const NICHES: readonly NicheRow[] = [
  { niche: "Local service businesses (plumbers, roofers, electricians)", quality: 2, budget: 3, value: 4, access: 4, deliverable: 5, note: "Often older sites; owners reachable by phone." },
  { niche: "Restaurants & hospitality", quality: 2, budget: 2, value: 3, access: 4, deliverable: 5, note: "Menus/booking flows break often; budgets tighter." },
  { niche: "Professional services (accountants, lawyers, advisors)", quality: 3, budget: 4, value: 4, access: 3, deliverable: 4, note: "Care about credibility; expect polished outreach." },
  { niche: "Small e-commerce stores", quality: 3, budget: 3, value: 4, access: 3, deliverable: 3, note: "Checkout friction is high-value; fixes can be involved." },
  { niche: "Clinics and local practices", quality: 3, budget: 4, value: 4, access: 3, deliverable: 4, note: "Respect privacy/marketing rules that apply to healthcare." },
  { niche: "Small agencies with aging websites", quality: 4, budget: 3, value: 3, access: 4, deliverable: 5, note: "They notice quality; may also become referral partners." },
] as const;

export const NICHE_CRITERIA = ["Often-thin websites", "Ability to pay", "Value of the fix", "Easy legitimate contact", "You can deliver"] as const;
export const NICHE_DISCLAIMER = "Illustrative ratings on a 1–5 scale to demonstrate how to compare niches — not measured market research and not a promise of results. Replace them with your own assessment.";

/* -------------------------------- section 4 weaknesses --------------------- */

export interface WeaknessItem { title: string; inspect: string; verify: string; matters: string; evidence: string; dont: string }

export const WEAKNESSES: readonly WeaknessItem[] = [
  { title: "Broken internal or external links", inspect: "Navigation, footer, contact and service pages.", verify: "SiteInsights checks every found link; click the flagged ones yourself.", matters: "Visitors and search crawlers hit dead ends exactly where the business wants action.", evidence: "The audit's finding list with affected URLs; a screenshot of the 404 page.", dont: "Don't call every 404 a business emergency — check which pages use it." },
  { title: "Slow-loading pages (measured)", inspect: "The start page on mobile with throttled conditions, not your office fibre.", verify: "Enable SiteInsights' performance option (PageSpeed Insights) and repeat once.", matters: "Slow pages waste the attention of mobile visitors.", evidence: "The performance section's lab metrics with date and conditions.", dont: "Don't claim a lab score equals lost sales; present it as a usability risk." },
  { title: "Poor mobile usability", inspect: "Menus, text size, tap targets, horizontal scrolling on a real phone.", verify: "Use browser-rendering findings plus your own device walkthrough.", matters: "Most local-business visitors arrive on phones.", evidence: "A screenshot of the broken state plus the failing element.", dont: "Don't rely on one viewport size; check at least two." },
  { title: "Missing or confusing calls to action", inspect: "Can a new visitor find how to contact or buy within 5 seconds?", verify: "Write down the actual path a visitor must take.", matters: "Unclear next steps leak the interest the business already earned.", evidence: "Annotated screenshot of the landing view.", dont: "Don't claim an A/B-test-worthy gain you haven't measured." },
  { title: "Outdated information", inspect: "Prices, opening hours, staff pages, copyright years, announcements.", verify: "Cross-check with a public profile or a recent post.", matters: "Stale details erode trust and generate wasted calls.", evidence: "Snapshot with the date visible.", dont: "Don't assume it's wrong — confirm before calling." },
  { title: "Navigation problems", inspect: "Dead-end pages, orphan pages, inconsistent menus.", verify: "SiteInsights flags candidate orphan pages; confirm by browsing.", matters: "Visitors can't find pages the business paid to create.", evidence: "The audit note plus a click path that fails.", dont: "Don't call pages orphaned that are simply beyond the crawl limit — the report says candidates." },
  { title: "Accessibility issues", inspect: "Alt text, form labels, contrast, keyboard reachability.", verify: "Automated axe-core findings, then a manual pass on flagged elements.", matters: "Real visitors with real needs are excluded.", evidence: "The element, the WCAG reference, and how you confirmed it.", dont: "Never claim legal noncompliance from a scanner; automated tests can't establish that." },
  { title: "Missing or incorrect metadata", inspect: "Titles, descriptions, canonical tags on key pages.", verify: "The audit's SEO section lists them per page.", matters: "Search results show whatever text exists — or none.", evidence: "Page source snippet via the affected URL.", dont: "Don't promise rankings; metadata is presentation, not a lever you can guarantee." },
  { title: "Broken images", inspect: "Hero images, galleries, staff photos.", verify: "SiteInsights checks discovered images like links.", matters: "Visible breakage undermines perceived reliability.", evidence: "Screenshot plus the failing asset URL.", dont: "Don't report images blocked by bot protection as broken — they're marked unverified." },
  { title: "Unclear contact information", inspect: "Is there a reachable phone, form or address — and does the form work?", verify: "Submit a clearly-labelled test message or note the absence.", matters: "The entire website exists to produce this contact.", evidence: "Steps taken and outcome, in one sentence.", dont: "Don't submit fake orders or spam forms to \"prove\" anything." },
  { title: "Inconsistent page structure", inspect: "Headings hierarchy, layout shifts between pages.", verify: "Compare two or three representative pages directly.", matters: "Inconsistency reads as neglect even when content is fine.", evidence: "Side-by-side screenshots.", dont: "Don't treat stylistic preference as a defect." },
  { title: "Technical errors (confirmed)", inspect: "Mixed content, failed requests, JavaScript errors on rendered pages.", verify: "Browser-rendering findings list the exact failing request/console error.", matters: "Silent failures break features the owner believes work.", evidence: "The console/network entry from the audit.", dont: "Don't extrapolate one console warning into \"your site is insecure\"." },
] as const;

/* -------------------------------- section 5 real UI facts ------------------ */

/** Every item below names a capability that exists in this repository. */
export const AUDIT_TUTORIAL_STEPS = [
  { title: "Open “New audit”", body: "From the header, start a free audit — the route is /audit/new. It works for signed-out visitors too (one free audit at a time); an account unlocks your Dashboard with history." },
  { title: "Enter the prospect's address", body: "Type the website's address in the URL field — “example.com” or a full https:// URL both work." },
  { title: "Choose the available options", body: "Depending on this server's configuration you can enable Browser rendering (a few key pages in real Chromium — catches JavaScript errors, failed requests and mobile layout issues), Accessibility (axe-core), and Performance (PageSpeed Insights for the start page). Disabled options are labelled \"not enabled on this site\" — that's a real limitation, not a bug." },
  { title: "Start the audit", body: "Submit the form. SiteInsights crawls the site breadth-first, respects robots.txt and crawl-delay, and checks every link and image it finds — the progress view shows pages discovered, queued, scanned, skipped and failed as they happen." },
  { title: "Read the results", body: "The audit report (your audit's page) groups findings with severity, affected URLs, evidence and a recommended fix per finding. It also states what was and wasn't evaluated." },
  { title: "Identify what is important", body: "Sort by severity, then apply judgment: a finding matters when it sits on a path customers actually use (contact, booking, checkout). The dashboard's priority views help; the final call is yours." },
  { title: "Verify manually", body: "Click the flagged links yourself. Sites that block automated checks are marked \"unverified\" — never present those as broken." },
  { title: "Export the evidence", body: "Download the branded PDF report from the audit page, export the raw JSON, or create a client report link — a read-only, expiring, revocable view you can send (shown as \"Client report links\" on the audit page)." },
  { title: "Attach it to a lead", body: "Save the finished audit as a prospect: the verified findings attach to that prospect in Dashboard → Prospects, keeping evidence and lead state together." },
] as const;

/* -------------------------------- section 6 priority matrix ---------------- */

export interface PriorityExample { finding: string; relevance: string; priority: string; x: number; y: number }

/** x = confidence 0..1 (left→right), y = business impact 0..1 (bottom→top) for the matrix plot. */
export const PRIORITY_EXAMPLES: readonly PriorityExample[] = [
  { finding: "Contact form fails to submit", relevance: "Potential lost inquiries", priority: "High — reproduce the failure first", x: 0.85, y: 0.9 },
  { finding: "Main CTA is difficult to find", relevance: "Potential friction for visitors", priority: "Medium–high, depending on context", x: 0.6, y: 0.7 },
  { finding: "One broken image on an old blog post", relevance: "Limited impact in many cases", priority: "Low–medium", x: 0.9, y: 0.2 },
  { finding: "Missing meta description", relevance: "Search-result presentation opportunity", priority: "Usually not an emergency", x: 0.95, y: 0.35 },
  { finding: "HTTPS page loads an HTTP script (mixed content)", relevance: "A feature may silently fail", priority: "High when a key page is affected", x: 0.8, y: 0.75 },
  { finding: "Mobile menu cannot be opened", relevance: "Mobile visitors are blocked", priority: "Critical if confirmed on a device", x: 0.75, y: 0.95 },
] as const;

export const PRIORITY_CRITERIA = [
  { label: "Severity", hint: "Does it block or merely annoy?" },
  { label: "Confidence", hint: "Did you reproduce it, or did a tool flag it?" },
  { label: "Likely user impact", hint: "Is it on a path customers actually use?" },
  { label: "Business relevance", hint: "Can you explain it without jargon?" },
  { label: "Effort to fix", hint: "Can you deliver it quickly and safely?" },
] as const;

/* -------------------------------- section 7 report ------------------------- */

export const REPORT_STRUCTURE = [
  { part: "Cover", body: "Prospect website, your name, date. Nothing else." },
  { part: "Executive summary", body: "Three sentences: what you looked at, what you verified, what you propose." },
  { part: "3–5 verified findings", body: "Only what you reproduced. Each with severity and affected URLs." },
  { part: "Evidence", body: "URL + screenshot or the audit's evidence per finding." },
  { part: "Business relevance", body: "Cautious, specific phrasing — \"may prevent contact\", not \"costs you customers\"." },
  { part: "Recommended fixes", body: "The audit's own recommended fix per finding, in your words." },
  { part: "Order of implementation", body: "What you'd do first and why." },
  { part: "Scope & next step (optional)", body: "A small first project with deliverables and timeframe." },
  { part: "Contact & branding", body: "Your professional profiles — see section 08." },
] as const;

/* -------------------------------- section 9/10 scripts --------------------- */

export interface Script { id: string; scene: string; text: string }

export const CALL_SCRIPTS: readonly Script[] = [
  { id: "receptionist", scene: "A receptionist answers", text: "\"Good morning — my name is [Name], I'm a web developer. Could I briefly speak with whoever looks after your website? It's about one small technical detail I noticed on the site — nothing urgent.\"" },
  { id: "owner-direct", scene: "Speaking with the owner directly", text: "\"Hi [Owner], I'm [Name]. I build and fix websites locally. While looking at [Business]'s website I confirmed one specific issue — [one verified finding in plain words]. Would it be useful if I sent you a one-page explanation?\"" },
  { id: "owner-busy", scene: "The owner is busy", text: "\"Of course — I appreciate that. May I email you two short paragraphs with what I found, and you can look when you have a moment? … Thank you, I'll keep it short.\"" },
  { id: "what-about", scene: "“What is this about?”", text: "\"It's about your website. I found one reproducible problem — [finding] — and I thought you should know. I can explain it on the phone in a minute, or send it in writing. Which do you prefer?\"" },
  { id: "selling", scene: "“Are you selling something?”", text: "\"Fair question. I do web work professionally, yes. But the issue is real either way — I'll happily send the finding so you can pass it to whoever maintains your site, whether or not we ever speak again.\"" },
  { id: "price", scene: "“How much would this cost?”", text: "\"For this specific fix, typically [your honest range] and about [time]. I'd confirm the exact scope in writing before you agree to anything — no surprises.\"" },
  { id: "have-developer", scene: "“We already have a developer”", text: "\"That's good — many strong sites do. This finding is still worth a look; want me to send it so you can forward it to them? Obviously no obligation at all.\"" },
  { id: "skeptic", scene: "The owner is skeptical", text: "\"Skepticism is healthy. Here's the verification: [URL], then [steps]. You can reproduce it in thirty seconds. I'll send exactly that — nothing more.\"" },
  { id: "declines", scene: "The owner declines", text: "\"Understood — thank you for your time. I won't follow up again; if it ever becomes relevant, my name is [Name] and the finding is documented in one page. Have a good day.\"" },
  { id: "voicemail", scene: "Leaving a short voicemail", text: "\"Hello [Business], this is [Name], a local web developer — [phone number]. I found one specific technical issue on your website that affects [plain impact]. I've written it up in one page; if you'd like it, just call or email [contact]. No pressure either way. Again, [Name], [number].\"" },
] as const;

export interface Hook { id: string; title: string; text: string; when: string; verify: string; personalize: string; next: string; avoid: string }

export const OPENING_HOOKS: readonly Hook[] = [
  { id: "broken-link", title: "Hook 1 — Verified broken link", text: "Hi, I'm [Name]. I was checking your website and noticed that the link on [specific page] appears to be broken. I wanted to let you know because it may affect visitors trying to reach that information.", when: "The audit flagged a link and you clicked it yourself — it's really broken.", verify: "Click it twice; note the URL and the error page you saw.", personalize: "Name the page and what the link was supposed to do (\"the 'Book a table' button on your homepage\").", next: "Offer the one-page explanation or their developer's fix path.", avoid: "\"Your site is full of broken links\" unless the audit shows many — and even then, say the number." },
  { id: "mobile", title: "Hook 2 — Mobile experience", text: "Hi, I'm [Name]. I visited your website on a phone and noticed [specific, reproducible issue]. Would you be open to a quick explanation of what I found?", when: "You reproduced a mobile problem on a real device.", verify: "Record model/browser and the exact steps that reproduce it.", personalize: "Reference the exact screen: \"when I open the menu on a phone, the contact link disappears\".", next: "Ask permission to send a screenshot with a 3-line explanation.", avoid: "\"Most of your visitors leave\" — you cannot know that without their analytics." },
  { id: "contact-path", title: "Hook 3 — Contact path", text: "Hi, I'm [Name]. I noticed something on your website that may make it harder for visitors to contact your business: [verified observation]. May I briefly explain?", when: "Contact = the site's most valuable action, and it's genuinely impaired.", verify: "Walk the path yourself end to end (a clearly-marked form test is fine).", personalize: "State what's missing precisely: \"the contact form fails after pressing Send\".", next: "Offer the documented walkthrough with the failing step marked.", avoid: "Submitting junk forms repeatedly — one labelled test is enough." },
  { id: "performance", title: "Hook 4 — Performance", text: "Hi, I'm [Name]. I measured your [specific page] and noticed [verified performance result under stated conditions]. I thought it might be useful to share the result and a possible improvement.", when: "You have an actual measurement — lab or field — with conditions you can state.", verify: "Run the performance option twice; report the typical result, not the worst.", personalize: "Compare to the patience of their customers, not to an industry statistic you can't cite.", next: "Offer the measurement plus one concrete fix (images, scripts, hosting).", avoid: "\"You're losing money\" — frame speed as a usability risk, calmly." },
  { id: "helpful", title: "Hook 5 — Helpful first contact", text: "Hi, I'm [Name]. I help businesses identify and fix website issues. I found one specific item on your site that I thought you should know about. Is now an inconvenient time?", when: "You genuinely found one specific item and want to lead with openness.", verify: "Have the item, its URL and the proof ready before dialling.", personalize: "Mention their business by name and the one item, not \"items\".", next: "If yes → thirty-second pitch; if busy → the voicemail/permission path.", avoid: "Fake urgency (\"your site will go down\") — never." },
] as const;

/* -------------------------------- section 11 emails ------------------------ */

export const EMAIL_TEMPLATES: readonly Script[] = [
  { id: "requested", scene: "The owner asked for the report", text: "Subject: The website issue we discussed — [specific finding in short]\n\nHi [Owner],\n\nas promised after our call, here is the short write-up. What I verified on [their site]:\n\n• [Finding 1 — one sentence, plain language, with the URL]\n• [Finding 2 — optional, same format]\n\nEach item includes the affected page and how to reproduce it. The attached report is read-only and was generated from my audit; my own verification steps are noted in it.\n\nSuggested next step: [single concrete fix + rough effort]. Happy to walk you through it in ten minutes if useful.\n\nKind regards,\n[Name] — [phone] — [portfolio URL]" },
  { id: "no-contact", scene: "No conversation happened yet (permitted follow-up channel)", text: "Subject: One specific website finding for [Business]\n\nHello [Owner/team],\n\nmy name is [Name]; I'm a web developer in [area]. While reviewing local business websites I confirmed one specific issue on yours: [finding, plain words, URL].\n\nI documented it with steps to reproduce — happy to send it over if useful, no strings attached. If you've already got someone for the website, feel free to forward it to them.\n\nBest regards,\n[Name] — [phone] — [portfolio URL]" },
  { id: "has-developer", scene: "The owner already has a developer", text: "Subject: For your developer — verified finding on [their site]\n\nHi [Owner],\n\nthanks for taking the call earlier. As discussed, here's the one finding I verified:\n\n• [Finding + URL + how to reproduce]\n\nFeel free to forward it to your developer — it should take them minutes to confirm. If they're ever overloaded, I'm around; otherwise, consider this a free nudge.\n\nRegards,\n[Name]" },
  { id: "declined", scene: "The owner asked for no further contact", text: "(Do not send anything. Remove them from your list — see section 13.)" },
] as const;

/* -------------------------------- section 12 objections -------------------- */

export interface Objection { quote: string; answer: string; principle: string }

export const OBJECTIONS: readonly Objection[] = [
  { quote: "We already have a developer.", answer: "Hand the verified finding to them as a courtesy and leave the door open. \"This one's yours regardless — if you ever need backup capacity, I'm nearby.\" Never disparage their developer.", principle: "Respect existing relationships; you're building a second contact, not replacing the first." },
  { quote: "Our website is working fine.", answer: "\"For most things, probably yes. This specific item isn't — here's the 30-second way to check it yourself.\" Offer proof instead of arguing.", principle: "Evidence beats persuasion." },
  { quote: "Send me the information.", answer: "Often a polite brush-off — comply with the shortest version (one page), then follow up once after 3–5 days.", principle: "Make the value density obvious by brevity." },
  { quote: "We don't have a budget.", answer: "\"Understood. When you do, start with the one fix that matters — [fix]. I can also write up the finding so any developer can do it.\" A small diagnostic-only project can also fit tiny budgets.", principle: "Never pressure; small honest work compounds." },
  { quote: "How much do you charge?", answer: "Answer with a range and a fixed small scope: \"For this fix, [range], typically [timeframe] — quoted exactly in writing before we start.\"", principle: "Vague pricing destroys trust faster than high pricing." },
  { quote: "How do I know this is legitimate?", answer: "Offer the verification steps, your real profiles (section 08), and a video walkthrough. Let them reproduce it themselves.", principle: "Verification, not reassurance." },
  { quote: "We are not interested.", answer: "\"Understood — thank you. I won't contact you again.\" Then don't.", principle: "Respect is a long-term asset; spam is not a strategy." },
] as const;

/* -------------------------------- section 13 pipeline ---------------------- */

export const FUNNEL_STAGES = [
  { stage: "Prospect identified", width: 100, hint: "Public websites in your niche" },
  { stage: "Website reviewed", width: 80, hint: "Quick human look first" },
  { stage: "Finding verified", width: 56, hint: "Only reproducible issues proceed" },
  { stage: "Report prepared", width: 44, hint: "Concise, evidence-based" },
  { stage: "First contact attempted", width: 36, hint: "One call or message" },
  { stage: "Report sent / requested", width: 26, hint: "Permission first" },
  { stage: "Follow-up due", width: 20, hint: "Once, maybe twice — then stop" },
  { stage: "Conversation booked", width: 14, hint: "A real discussion" },
  { stage: "Proposal sent", width: 9, hint: "Small, defined first project" },
  { stage: "Won / closed", width: 6, hint: "Deliver well; ask for referrals" },
] as const;

export const FUNNEL_NOTE = "Widths are illustrative shape, not statistics. Your conversion rates are yours to learn — section 14 shows how.";

/** The four statuses the real SiteInsights prospects feature uses (dashboard). */
export const REAL_PROSPECT_STATUSES = ["New", "Reviewing", "Contacted", "Converted"] as const;

/* -------------------------------- section 14 plan -------------------------- */

export const SEVEN_DAYS = [
  { day: 1, title: "Choose one niche, one service", detail: "One sentence each. \"I fix contact flows and broken pages for local clinics.\" Targets are adjustable examples — say, one niche, not five." },
  { day: 2, title: "Prepare your profiles", detail: "Consistent name, professional email, simple portfolio page. Section 08's checklist, nothing more fancy." },
  { day: 3, title: "Identify a batch of websites", detail: "Pick a small batch — e.g. 10 candidate business websites from public sources. Note why each made the list." },
  { day: 4, title: "Audit and verify", detail: "Run SiteInsights audits on the shortlist (batch audits help at volume). Keep only reproduced findings — usually 1–3 per site." },
  { day: 5, title: "Prepare concise reports", detail: "One page per prospect: the verified findings, evidence, suggested fix order. Export PDF or create a client report link." },
  { day: 6, title: "Contact owners professionally", detail: "Section 09–11's scripts. Track each attempt in Prospects (New → Contacted). Stop at decline." },
  { day: 7, title: "Follow up and review", detail: "One polite follow-up where appropriate. Review: which openers got answered? Improve the process, not the volume." },
] as const;

/* -------------------------------- section 15 checklist --------------------- */

export interface ChecklistItem { id: string; text: string }

export const FINAL_CHECKLIST: readonly ChecklistItem[] = [
  { id: "niche", text: "I can state my niche and my service in one sentence each." },
  { id: "profiles", text: "My email, portfolio page and professional profile are consistent and public." },
  { id: "method", text: "I find candidates only via public sources (search engines, directories, listings, professional networks)." },
  { id: "audit", text: "Each prospect site gets a real SiteInsights audit before I contact anyone." },
  { id: "verify", text: "I present only findings I reproduced myself, with URLs and evidence." },
  { id: "report", text: "My report has 3–5 verified findings — not a warning dump." },
  { id: "claim", text: "I make no promises about rankings, revenue or conversions I can't evidence." },
  { id: "script", text: "My opening line names one specific, verified observation." },
  { id: "consent", text: "Reports are sent only when the contact agreed — or once, politely, where unsolicited contact is lawful and appropriate." },
  { id: "honor-no", text: "A \"no\" or an opt-out is final and recorded." },
  { id: "pipeline", text: "Every prospect has a current stage in Prospects (or my table) and a next action or a closed state." },
  { id: "deliver", text: "I only sell work I can actually deliver, scoped small and written down." },
] as const;

export const MISTAKES = [
  { bad: "Contacting random businesses without a niche", fix: "One niche, one service (section 03)." },
  { bad: "Reporting issues you didn't verify", fix: "Reproduce everything first (sections 04–05)." },
  { bad: "Sending generic, lengthy reports", fix: "3–5 findings, one owner-readable page (section 07)." },
  { bad: "Exaggerated SEO / revenue / conversion claims", fix: "State evidence + risk, never guarantees (section 06)." },
  { bad: "Misrepresenting experience or results", fix: "Show verification steps instead of testimonials you don't have (section 08)." },
  { bad: "Fake urgency", fix: "Calm facts convert better and keep you credible (section 10)." },
  { bad: "Spamming calls and emails", fix: "One contact, one–two follow-ups, then stop (section 11, 13)." },
  { bad: "Selling services you can't deliver", fix: "Sell the small fix you can do today (section 12)." },
  { bad: "Never tracking follow-ups", fix: "A pipeline with stages — Prospects or the manual table (section 13)." },
  { bad: "Giving away endless free work", fix: "The courtesy finding is free; the fix is the first paid step." },
] as const;
