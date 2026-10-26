/**
 * Three.js crawl-map scene. Loaded on demand by HeroVisual (code-split), never
 * during server rendering. Restrained by design: flat colours from the brand
 * palette, no bloom/glow, slow rotation, paused when hidden or off-screen and a
 * single static frame when the user prefers reduced motion.
 */
import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";
import { buildCrawlGraph } from "./crawl-graph";

const BLUE = new Color("#0E436B");
const GOLD = new Color("#F4B43B");
const CHARCOAL = new Color("#1B2631");

export interface SceneHandle {
  dispose(): void;
}

export function mountCrawlScene(canvas: HTMLCanvasElement, opts: { reducedMotion: boolean }): SceneHandle {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  const scene = new Scene();
  const camera = new PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 4.6, 10.5);
  camera.lookAt(0, -0.2, 0);

  scene.add(new AmbientLight(0xffffff, 1.6));
  const key = new DirectionalLight(0xffffff, 1.4);
  key.position.set(4, 8, 6);
  scene.add(key);

  const nodes = buildCrawlGraph();
  const group = new Group();
  group.rotation.y = 0.6;
  scene.add(group);

  // Edges
  const pos: number[] = [];
  for (const n of nodes) {
    if (n.parent === null) continue;
    const p = nodes[n.parent];
    pos.push(p.x, p.y, p.z, n.x, n.y, n.z);
  }
  const edgeGeo = new BufferGeometry();
  edgeGeo.setAttribute("position", new Float32BufferAttribute(pos, 3));
  const edgeMat = new LineBasicMaterial({ color: BLUE, transparent: true, opacity: 0.32 });
  group.add(new LineSegments(edgeGeo, edgeMat));

  // Nodes (one instanced draw call)
  const nodeGeo = new IcosahedronGeometry(1, 1);
  const nodeMat = new MeshLambertMaterial({ flatShading: true });
  const mesh = new InstancedMesh(nodeGeo, nodeMat, nodes.length);
  const m = new Matrix4();
  nodes.forEach((n, i) => {
    const s = n.depth === 0 ? 0.26 : n.flagged ? 0.13 : 0.085 + (3 - n.depth) * 0.012;
    m.makeScale(s, s, s).setPosition(n.x, n.y, n.z);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, n.depth === 0 ? CHARCOAL : n.flagged ? GOLD : BLUE);
  });
  group.add(mesh);

  let width = 0;
  let height = 0;
  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h || (w === width && h === height)) return;
    width = w;
    height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const render = () => {
    resize();
    renderer.render(scene, camera);
  };

  let frame = 0;
  let visible = true;
  let last = performance.now();
  const loop = (now: number) => {
    frame = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    group.rotation.y += dt * 0.07;
    render();
  };
  const start = () => {
    if (opts.reducedMotion || frame || !visible || document.hidden) return;
    last = performance.now();
    frame = requestAnimationFrame(loop);
  };
  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  const io = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) start();
    else stop();
  });
  io.observe(canvas);
  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener("visibilitychange", onVisibility);
  const ro = new ResizeObserver(() => {
    if (!frame) render();
  });
  ro.observe(canvas);

  render();
  start();

  return {
    dispose() {
      stop();
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      edgeGeo.dispose();
      edgeMat.dispose();
      nodeGeo.dispose();
      nodeMat.dispose();
      mesh.dispose();
      renderer.dispose();
    },
  };
}
