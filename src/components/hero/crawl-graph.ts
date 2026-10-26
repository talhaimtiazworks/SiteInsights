/**
 * Deterministic, illustrative crawl map shared by the static SVG fallback and
 * the WebGL scene, so both show the same picture. It is decoration, not data:
 * the hero labels it as an illustration.
 */
export interface GraphNode {
  id: number;
  parent: number | null;
  depth: number;
  x: number;
  y: number;
  z: number;
  /** Nodes drawn in the accent colour (a page with a finding). */
  flagged: boolean;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildCrawlGraph(seed = 7, branching = [6, 3, 2]): GraphNode[] {
  const r = rng(seed);
  const nodes: GraphNode[] = [{ id: 0, parent: null, depth: 0, x: 0, y: 0, z: 0, flagged: false }];
  let frontier = [{ id: 0, angle: 0, spread: Math.PI * 2 }];
  for (let depth = 1; depth <= branching.length; depth++) {
    const next: typeof frontier = [];
    for (const p of frontier) {
      const n = branching[depth - 1];
      for (let i = 0; i < n; i++) {
        const angle = p.angle - p.spread / 2 + (p.spread * (i + 0.5)) / n + (r() - 0.5) * 0.12;
        const radius = depth * 1.35 + (r() - 0.5) * 0.35;
        const id = nodes.length;
        nodes.push({
          id,
          parent: p.id,
          depth,
          x: Math.cos(angle) * radius,
          y: (r() - 0.5) * 0.9 - depth * 0.08,
          z: Math.sin(angle) * radius,
          flagged: depth > 1 && r() < 0.16,
        });
        next.push({ id, angle, spread: (p.spread / n) * 0.92 });
      }
    }
    frontier = next;
  }
  return nodes;
}

/** Orthographic projection used by the SVG fallback (same camera tilt as the scene). */
export function project(n: Pick<GraphNode, "x" | "y" | "z">, yaw = 0.6, tilt = 0.5) {
  const cx = Math.cos(yaw) * n.x - Math.sin(yaw) * n.z;
  const cz = Math.sin(yaw) * n.x + Math.cos(yaw) * n.z;
  const cy = Math.cos(tilt) * n.y - Math.sin(tilt) * cz;
  const depth = Math.sin(tilt) * n.y + Math.cos(tilt) * cz;
  return { x: cx, y: cy, depth };
}
