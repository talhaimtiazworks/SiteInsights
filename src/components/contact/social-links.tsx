import Image from "next/image";
import type { ReactNode } from "react";

/**
 * Official social profiles for TalhaImtiazWorks on /contact.
 *
 * Artwork policy: every mark below is the platform's authentic asset — never a
 * redrawn, text-char, emoji, or invented stand-in.
 *   - TalhaImtiazWorks : official logo PNG from /public/brand (preserved byte-for-byte).
 *   - Contra           : official "ContraStarIcon" from Contra's own production design system.
 *   - GitHub / X / Threads / Pinterest : official monochrome glyphs (Simple Icons),
 *     rendered white (GitHub, X, Threads) or official brand red #E60023 (Pinterest).
 *   - LinkedIn         : official app icon (blue rounded square, white "in").
 *   - Instagram        : official 2016 multicolor app-icon artwork.
 *   - Jobbers.io       : real favicon/logo from jobbers.io, kept at its native size for crispness.
 * Facebook and YouTube are intentionally excluded per the product brief.
 * The two in-page "Show More" disclosure rows were removed per owner request:
 * every row below is a real, configured profile link — nothing expandable.
 */

type IconKey = "tiw" | "contra" | "github" | "linkedin" | "x" | "instagram" | "threads" | "pinterest" | "jobbers";

type SocialProfile = {
  name: string;
  subtitle: string;
  href: string;
  icon: IconKey;
};

export const SOCIAL_PROFILES: readonly SocialProfile[] = [
  { name: "TalhaImtiazWorks", subtitle: "Official contact & studio", href: "https://talhaimtiazworks.vercel.app/contact", icon: "tiw" },
  { name: "Contra", subtitle: "Studio profile & client work", href: "https://contra.com/talhaimtiazworks", icon: "contra" },
  { name: "GitHub", subtitle: "Code, builds & experiments", href: "https://github.com/talhaimtiazworks", icon: "github" },
  { name: "LinkedIn", subtitle: "Professional profile", href: "https://www.linkedin.com/in/talhaimtiazworks", icon: "linkedin" },
  { name: "X", subtitle: "Notes, launches & updates", href: "https://x.com/talhaimtiazwork", icon: "x" },
  { name: "Instagram", subtitle: "Visual work & studio life", href: "https://www.instagram.com/talhaimtiazworks/", icon: "instagram" },
  { name: "Threads", subtitle: "Conversations & short updates", href: "https://www.threads.com/@talhaimtiazworks", icon: "threads" },
  { name: "Pinterest", subtitle: "Visual references & boards", href: "https://www.pinterest.com/talhaimtiazworks/", icon: "pinterest" },
  { name: "Jobbers.io", subtitle: "Professional profile", href: "https://www.jobbers.io/author/talha-imtiaz/", icon: "jobbers" },
] as const;

function ContraIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[20px] w-[20px] shrink-0" fill="#ffffff">
      <path d="M10.5 0L9.93168 2.85907C9.22181 6.4302 6.4302 9.22181 2.85907 9.93168L0 10.5V13.5L2.85907 14.0683C6.43019 14.7782 9.22181 17.5698 9.93168 21.1409L10.5 24H13.5L14.0683 21.1409C14.7782 17.5698 17.5698 14.7782 21.1409 14.0683L24 13.5V10.5L21.1409 9.93168C17.5698 9.22181 14.7782 6.4302 14.0683 2.85907L13.5 0H10.5Z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[21px] w-[21px] shrink-0" fill="#ffffff">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg viewBox="0 0 72 72" aria-hidden="true" className="h-[21px] w-[21px] shrink-0 rounded-[4px]">
      <path d="M8,72 L64,72 C68.418278,72 72,68.418278 72,64 L72,8 C72,3.581722 68.418278,0 64,0 L8,0 C3.581722,0 0,3.581722 0,8 L0,64 C0,68.418278 3.581722,72 8,72 Z" fill="#007EBB" />
      <path d="M62,62 L51.315625,62 L51.315625,43.8021149 C51.315625,38.8127542 49.4197917,36.0245323 45.4707031,36.0245323 C41.1746094,36.0245323 38.9300781,38.9261103 38.9300781,43.8021149 L38.9300781,62 L28.6333333,62 L28.6333333,27.3333333 L38.9300781,27.3333333 L38.9300781,32.0029283 C38.9300781,32.0029283 42.0260417,26.2742151 49.3825521,26.2742151 C56.7356771,26.2742151 62,30.7644705 62,40.051212 L62,62 Z M16.349349,22.7940133 C12.8420573,22.7940133 10,19.9296567 10,16.3970067 C10,12.8643566 12.8420573,10 16.349349,10 C19.8566406,10 22.6970052,12.8643566 22.6970052,16.3970067 C22.6970052,19.9296567 19.8566406,22.7940133 16.349349,22.7940133 Z M11.0325521,62 L21.769401,62 L21.769401,27.3333333 L11.0325521,27.3333333 L11.0325521,62 Z" fill="#ffffff" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[18px] w-[18px] shrink-0" fill="#ffffff">
      <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
    </svg>
  );
}

function InstagramIcon() {
  return (
    <svg viewBox="0 0 134 134" aria-hidden="true" className="h-[21px] w-[21px] shrink-0 rounded-[5px]">
      <defs>
        <linearGradient id="contact-ig-b">
          <stop offset="0" stopColor="#3771c8" />
          <stop offset="0.128" stopColor="#3771c8" />
          <stop offset="1" stopColor="#60f" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="contact-ig-a">
          <stop offset="0" stopColor="#fd5" />
          <stop offset="0.1" stopColor="#fd5" />
          <stop offset="0.5" stopColor="#ff543e" />
          <stop offset="1" stopColor="#c837ab" />
        </linearGradient>
        <radialGradient id="contact-ig-c" cx="158.429" cy="578.088" r="65" gradientUnits="userSpaceOnUse" gradientTransform="matrix(0 -1.98198 1.8439 0 -1031.402 454.004)" fx="158.429" fy="578.088" href="#contact-ig-a" />
        <radialGradient id="contact-ig-d" cx="147.694" cy="473.455" r="65" gradientUnits="userSpaceOnUse" gradientTransform="matrix(.17394 .86872 -3.5818 .71718 1648.348 -458.493)" fx="147.694" fy="473.455" href="#contact-ig-b" />
      </defs>
      <path fill="url(#contact-ig-c)" d="M65.03 0C37.888 0 29.95.028 28.407.156c-5.57.463-9.036 1.34-12.812 3.22-2.91 1.445-5.205 3.12-7.47 5.468C4 13.126 1.5 18.394.595 24.656c-.44 3.04-.568 3.66-.594 19.188-.01 5.176 0 11.988 0 21.125 0 27.12.03 35.05.16 36.59.45 5.42 1.3 8.83 3.1 12.56 3.44 7.14 10.01 12.5 17.75 14.5 2.68.69 5.64 1.07 9.44 1.25 1.61.07 18.02.12 34.44.12 16.42 0 32.84-.02 34.41-.1 4.4-.207 6.955-.55 9.78-1.28 7.79-2.01 14.24-7.29 17.75-14.53 1.765-3.64 2.66-7.18 3.065-12.317.088-1.12.125-18.977.125-36.81 0-17.836-.04-35.66-.128-36.78-.41-5.22-1.305-8.73-3.127-12.44-1.495-3.037-3.155-5.305-5.565-7.624C116.9 4 111.64 1.5 105.372.596 102.335.157 101.73.027 86.19 0H65.03z" transform="translate(1.004 1)" />
      <path fill="url(#contact-ig-d)" d="M65.03 0C37.888 0 29.95.028 28.407.156c-5.57.463-9.036 1.34-12.812 3.22-2.91 1.445-5.205 3.12-7.47 5.468C4 13.126 1.5 18.394.595 24.656c-.44 3.04-.568 3.66-.594 19.188-.01 5.176 0 11.988 0 21.125 0 27.12.03 35.05.16 36.59.45 5.42 1.3 8.83 3.1 12.56 3.44 7.14 10.01 12.5 17.75 14.5 2.68.69 5.64 1.07 9.44 1.25 1.61.07 18.02.12 34.44.12 16.42 0 32.84-.02 34.41-.1 4.4-.207 6.955-.55 9.78-1.28 7.79-2.01 14.24-7.29 17.75-14.53 1.765-3.64 2.66-7.18 3.065-12.317.088-1.12.125-18.977.125-36.81 0-17.836-.04-35.66-.128-36.78-.41-5.22-1.305-8.73-3.127-12.44-1.495-3.037-3.155-5.305-5.565-7.624C116.9 4 111.64 1.5 105.372.596 102.335.157 101.73.027 86.19 0H65.03z" transform="translate(1.004 1)" />
      <path fill="#ffffff" transform="translate(1.004 1)" d="M66.004 18c-13.036 0-14.672.057-19.792.29-5.11.234-8.598 1.043-11.65 2.23-3.157 1.226-5.835 2.866-8.503 5.535-2.67 2.668-4.31 5.346-5.54 8.502-1.19 3.053-2 6.542-2.23 11.65C18.06 51.327 18 52.964 18 66s.058 14.667.29 19.787c.235 5.11 1.044 8.598 2.23 11.65 1.227 3.157 2.867 5.835 5.536 8.503 2.667 2.67 5.345 4.314 8.5 5.54 3.054 1.187 6.543 1.996 11.652 2.23 5.12.233 6.755.29 19.79.29 13.037 0 14.668-.057 19.788-.29 5.11-.234 8.602-1.043 11.656-2.23 3.156-1.226 5.83-2.87 8.497-5.54 2.67-2.668 4.31-5.346 5.54-8.502 1.18-3.053 1.99-6.542 2.23-11.65.23-5.12.29-6.752.29-19.788 0-13.036-.06-14.672-.29-19.792-.24-5.11-1.05-8.598-2.23-11.65-1.23-3.157-2.87-5.835-5.54-8.503-2.67-2.67-5.34-4.31-8.5-5.535-3.06-1.187-6.55-1.996-11.66-2.23-5.12-.233-6.75-.29-19.79-.29zm-4.306 8.65c1.278-.002 2.704 0 4.306 0 12.816 0 14.335.046 19.396.276 4.68.214 7.22.996 8.912 1.653 2.24.87 3.837 1.91 5.516 3.59 1.68 1.68 2.72 3.28 3.592 5.52.657 1.69 1.44 4.23 1.653 8.91.23 5.06.28 6.58.28 19.39s-.05 14.33-.28 19.39c-.214 4.68-.996 7.22-1.653 8.91-.87 2.24-1.912 3.835-3.592 5.514-1.68 1.68-3.275 2.72-5.516 3.59-1.69.66-4.232 1.44-8.912 1.654-5.06.23-6.58.28-19.396.28-12.817 0-14.336-.05-19.396-.28-4.68-.216-7.22-.998-8.913-1.655-2.24-.87-3.84-1.91-5.52-3.59-1.68-1.68-2.72-3.276-3.592-5.517-.657-1.69-1.44-4.23-1.653-8.91-.23-5.06-.276-6.58-.276-19.398s.046-14.33.276-19.39c.214-4.68.996-7.22 1.653-8.912.87-2.24 1.912-3.84 3.592-5.52 1.68-1.68 3.28-2.72 5.52-3.592 1.692-.66 4.233-1.44 8.913-1.655 4.428-.2 6.144-.26 15.09-.27zm29.928 7.97c-3.18 0-5.76 2.577-5.76 5.758 0 3.18 2.58 5.76 5.76 5.76 3.18 0 5.76-2.58 5.76-5.76 0-3.18-2.58-5.76-5.76-5.76zm-25.622 6.73c-13.613 0-24.65 11.037-24.65 24.65 0 13.613 11.037 24.645 24.65 24.645C79.617 90.645 90.65 79.613 90.65 66S79.616 41.35 66.003 41.35zm0 8.65c8.836 0 16 7.163 16 16 0 8.836-7.164 16-16 16-8.837 0-16-7.164-16-16 0-8.837 7.163-16 16-16z" />
    </svg>
  );
}

function ThreadsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[19px] w-[19px] shrink-0" fill="#ffffff">
      <path d="M18.263 11.097c-.03-3.486-1.92-5.586-5.111-5.586-2.13 0-3.922.963-4.863 2.499l2.062 1.438c.535-.843 1.272-1.543 2.628-1.543 1.528 0 2.318.85 2.544 2.431a15 15 0 0 0-2.236-.173c-4.125 0-6.068 1.867-6.068 4.336s1.943 3.99 4.804 3.99c3.139 0 5.013-2.115 5.781-4.735.798.361 1.348 1.204 1.348 2.47 0 3.387-3.907 5.232-7.22 5.232-4.885 0-8.077-3.207-8.077-8.424 0-6.392 4.223-10.487 9.9-10.487 3.808 0 5.69 1.671 6.97 3.914l2.108-1.475C21.44 2.078 18.331 0 13.663 0 6.227 0 1.168 5.277 1.168 12.934c0 7 4.953 11.066 10.856 11.066 4.878 0 9.809-2.846 9.809-7.716 0-2.545-1.46-4.231-3.569-5.187m-6.33 4.855c-1.077 0-2.026-.512-2.026-1.453 0-1.483 1.822-1.934 3.606-1.934.678 0 1.34.045 1.927.173-.422 1.927-1.671 3.215-3.508 3.214Z" />
    </svg>
  );
}

function PinterestIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[20px] w-[20px] shrink-0" fill="#E60023">
      <path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z" />
    </svg>
  );
}

const ICONS: Record<IconKey, ReactNode> = {
  tiw: (
    <Image src="/brand/talhaimtiazworks-logo-160.png" alt="" role="presentation" width={160} height={160} className="h-[24px] w-[24px] shrink-0" />
  ),
  contra: <ContraIcon />,
  github: <GitHubIcon />,
  linkedin: <LinkedInIcon />,
  x: <XIcon />,
  instagram: <InstagramIcon />,
  threads: <ThreadsIcon />,
  pinterest: <PinterestIcon />,
  jobbers: (
    <Image src="/brand/social/jobbers-io-logo.png" alt="" role="presentation" width={16} height={20} className="h-[20px] w-[16px] shrink-0" />
  ),
};

function ExternalMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[16px] w-[16px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 17L17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

function SparkGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[12px] w-[12px]" fill="currentColor">
      <path d="M12 1.5 13.6 8.4 21 10l-6.9 2.4L12 22.5 10.4 15.6 3 13.2 9.6 11 12 1.5Z" />
    </svg>
  );
}

function ProfileRow({ profile, index }: { profile: SocialProfile; index: number }) {
  // Fixed-column grid: every index, icon, name, description and arrow aligns
  // on the same invisible grid across ALL rows. The flexible name column is
  // wide enough that no name wraps; overflow truncates instead of shifting
  // columns. The entire row is a single <a> — no nested controls — so keyboard
  // users Tab once per profile and the whole row is the accessible hit target.
  const rowClass =
    "group -mx-2 grid w-[calc(100%+1rem)] grid-cols-[1.5rem_1.875rem_minmax(0,1fr)_1.5rem] items-center gap-x-3 rounded-lg px-2 py-4 outline-none transition-colors duration-150 hover:bg-white/[0.04] focus-visible:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70 min-[420px]:grid-cols-[1.5rem_1.875rem_minmax(7rem,9.5rem)_minmax(0,1fr)_1.5rem] sm:py-[1.15rem]";
  return (
    <li>
      <a href={profile.href} target="_blank" rel="noopener noreferrer" className={rowClass}>
        <span aria-hidden="true" className="block w-6 self-center text-[13px] font-medium tabular-nums text-white/45">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span aria-hidden="true" className="flex h-[1.875rem] w-[1.875rem] items-center justify-center self-center">
          {ICONS[profile.icon]}
        </span>
        <span className="min-w-0 self-center truncate whitespace-nowrap text-[15px] font-semibold leading-[1.2] text-white" title={profile.name}>
          {profile.name}
        </span>
        <span className="sr-sub hidden min-w-0 self-center truncate whitespace-nowrap text-[10.5px] font-medium uppercase text-white/55 min-[420px]:block" style={{ letterSpacing: "0.12em" }} title={profile.subtitle}>
          {profile.subtitle}
        </span>
        <span className="flex h-7 w-7 flex-none items-center justify-center self-center text-white/40 transition-colors duration-150 group-hover:text-white group-focus-visible:text-white">
          <ExternalMark />
        </span>
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    </li>
  );
}

/**
 * Numbered directory of the studio's official social profiles.
 * Two balanced columns on desktop (01-05 / 06-09), one column on mobile,
 * keeping sequential reading order everywhere.
 */
export function SocialLinksSection() {
  // Nine real profiles, balanced 5 + 4 across two columns on desktop and a
  // single clean column on mobile — sequential reading order everywhere.
  const columnOne = SOCIAL_PROFILES.slice(0, 5);
  const columnTwo = SOCIAL_PROFILES.slice(5);
  return (
    <section aria-labelledby="official-social-profiles" className="overflow-x-clip rounded-xl border border-white/10 bg-[#251c36]">
      <div className="px-5 pb-8 pt-8 sm:px-8 sm:pt-10">
        <div className="flex justify-center">
          <p className="inline-flex items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-white/70">
            <SparkGlyph />
            TalhaImtiaz · official profiles
            <SparkGlyph />
          </p>
        </div>
        <h2 id="official-social-profiles" className="mt-5 text-center text-xl font-semibold tracking-tight text-white sm:text-2xl">
          Official social channels
        </h2>
        <p className="mx-auto mt-2 max-w-lg text-center text-sm leading-relaxed text-white/60">
          Every verified TalhaImtiazWorks profile in one place. Links open in a new tab.
        </p>

        <div className="mt-8 grid gap-y-8 md:grid-cols-2 md:gap-x-12 md:gap-y-0 lg:gap-x-14">
          <ol className="min-w-0 divide-y divide-white/10 border-y border-white/10">
            {columnOne.map((profile, index) => (
              <ProfileRow key={profile.href} profile={profile} index={index} />
            ))}
          </ol>
          {/* border-t drops to 0 on mobile so the stacked columns share a single hairline */}
          <ol className="min-w-0 divide-y divide-white/10 border-b border-t-0 border-white/10 md:border-t">
            {columnTwo.map((profile, offset) => (
              <ProfileRow key={profile.href} profile={profile} index={5 + offset} />
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

export default SocialLinksSection;
