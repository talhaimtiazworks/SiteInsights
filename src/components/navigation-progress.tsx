"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** Delayed feedback only for genuinely pending transitions; never delays ready content. */
export function NavigationProgress() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [visible, setVisible] = useState(false);
  const stopRef = useRef<() => void>(() => {});

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let safety: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { clearTimeout(timer); clearTimeout(safety); timer = safety = undefined; setVisible(false); };
    const start = () => { stop(); timer = setTimeout(() => setVisible(true), 150); safety = setTimeout(stop, 15_000); };
    stopRef.current = stop;
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a");
      if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self") || !link.href) return;
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
      start();
    };
    document.addEventListener("click", click, true);
    window.addEventListener("siteinsights:navigate", start);
    window.addEventListener("popstate", start);
    window.addEventListener("pageshow", stop);
    window.addEventListener("pagehide", stop);
    return () => {
      stop();
      document.removeEventListener("click", click, true);
      window.removeEventListener("siteinsights:navigate", start);
      window.removeEventListener("popstate", start);
      window.removeEventListener("pageshow", stop);
      window.removeEventListener("pagehide", stop);
    };
  }, []);

  useEffect(() => { const timer = setTimeout(() => stopRef.current(), 0); return () => clearTimeout(timer); }, [pathname, search]);
  if (!visible) return null;
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="pointer-events-none fixed inset-x-0 top-0 z-[60]">
      <span className="sr-only">Loading your workspace…</span>
      <div aria-hidden="true" className="h-1 w-full overflow-hidden bg-primary/10">
        <div className="nav-progress-bar h-full w-1/3 rounded-r-full bg-accent" />
      </div>
    </div>
  );
}
