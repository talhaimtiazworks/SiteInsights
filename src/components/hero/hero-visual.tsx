"use client";

import { useEffect, useRef, useState } from "react";
import { buildCrawlGraph, project } from "./crawl-graph";

/** True when a WebGL context can actually be created (not just when the API exists). */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return false;
    (gl as WebGLRenderingContext).getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Static crawl map: server-rendered, used before the 3D scene loads and whenever WebGL is unavailable. */
export function CrawlMapSvg({ className }: { className?: string }) {
  const nodes = buildCrawlGraph();
  const pts = nodes.map((n) => project(n));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const pad = 0.5;
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const w = Math.max(...xs) + pad - minX;
  const h = Math.max(...ys) + pad - minY;
  const X = (x: number) => (x - minX).toFixed(3);
  const Y = (y: number) => (h - (y - minY)).toFixed(3);
  return (
    <svg viewBox={`0 0 ${w.toFixed(3)} ${h.toFixed(3)}`} className={className} aria-hidden="true" focusable="false">
      <g stroke="#0E436B" strokeOpacity="0.3" strokeWidth="0.025">
        {nodes.map((n, i) => (n.parent === null ? null : <line key={i} x1={X(pts[n.parent].x)} y1={Y(pts[n.parent].y)} x2={X(pts[i].x)} y2={Y(pts[i].y)} />))}
      </g>
      {nodes
        .map((n, i) => ({ n, p: pts[i] }))
        .sort((a, b) => a.p.depth - b.p.depth)
        .map(({ n, p }) => (
          <circle key={n.id} cx={X(p.x)} cy={Y(p.y)} r={n.depth === 0 ? 0.24 : n.flagged ? 0.12 : 0.08} fill={n.depth === 0 ? "#1B2631" : n.flagged ? "#F4B43B" : "#0E436B"} />
        ))}
    </svg>
  );
}

type Mode = "static" | "loading" | "webgl";

/**
 * Hero illustration. The SVG renders immediately (and is the permanent fallback);
 * Three.js is fetched only after hydration, when the browser supports WebGL and
 * the element is near the viewport. Failures fall back silently to the SVG.
 */
export function HeroVisual() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<Mode>("static");

  useEffect(() => {
    const el = wrap.current;
    if (!el || !webglAvailable()) return;
    let disposed = false;
    let handle: { dispose(): void } | null = null;
    const io = new IntersectionObserver(
      async ([entry]) => {
        if (!entry.isIntersecting || handle || disposed) return;
        io.disconnect();
        setMode("loading");
        try {
          const { mountCrawlScene } = await import("./crawl-scene");
          if (disposed || !canvas.current) return;
          const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          handle = mountCrawlScene(canvas.current, { reducedMotion });
          setMode("webgl");
        } catch {
          if (!disposed) setMode("static");
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => {
      disposed = true;
      io.disconnect();
      handle?.dispose();
    };
  }, []);

  return (
    <div ref={wrap} className="relative aspect-[5/4] w-full" data-hero-mode={mode}>
      <CrawlMapSvg className={`absolute inset-0 h-full w-full transition-opacity duration-500 ${mode === "webgl" ? "opacity-0" : "opacity-100"}`} />
      <canvas ref={canvas} className={`absolute inset-0 h-full w-full transition-opacity duration-500 ${mode === "webgl" ? "opacity-100" : "opacity-0"}`} aria-hidden="true" />
    </div>
  );
}
