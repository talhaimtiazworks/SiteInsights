import Link from "next/link";
import { cn } from "@/lib/ui";
import { BRAND } from "@/lib/brand";

/** The supplied official artwork, never recreated as vectors or recolored by a theme. */
export function LogoMark({ className = "h-12 w-12", tile = false, title }: { className?: string; tile?: boolean; title?: string }) {
  return (
    // Local, pre-sized PNG derivatives preserve the entire original 1:1 canvas and alpha.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={BRAND.logo}
      srcSet="/brand/talhaimtiazworks-logo-160.png 160w, /brand/talhaimtiazworks-logo-320.png 320w, /brand/talhaimtiazworks-logo-640.png 640w"
      sizes="(max-width: 640px) 80px, 120px"
      width={320}
      height={320}
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      draggable={false}
      className={cn("official-logo shrink-0 object-contain", tile && "rounded-full", className)}
    />
  );
}

export function Wordmark({ className }: { className?: string }) {
  return <span className={cn("whitespace-nowrap font-display font-bold tracking-[-0.03em]", className)}>{BRAND.name}</span>;
}

export function Logo({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn("inline-flex shrink-0 items-center gap-2 min-[360px]:gap-2.5 rounded-md", className)}>
      <LogoMark className="h-9 w-9 min-[360px]:h-10 min-[360px]:w-10" />
      <span className="flex flex-col">
        <Wordmark className="text-[1.0625rem] leading-5 text-charcoal" />{" "}
        <span className="text-[10px] font-medium leading-4 tracking-wide text-muted-foreground">by {BRAND.parent}</span>
      </span>
      <span className="sr-only"> home</span>
    </Link>
  );
}
