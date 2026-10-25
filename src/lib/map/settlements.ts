// The 23,000 settlement dots as one particles layer (one GPU draw, no DOM), shared by the globe
// pages. Four groups by size (roofs) so a bigger village is a bigger dot; sizes are in globe units
// with perspective so a hamlet is under a pixel far out and a few pixels up close. The dots sit at
// altitude 0: point sprites are centred on their vertex, so size never moves the centre, and at
// ground level they stay on their pixel when the view is oblique.

import type { Band } from "./pin";
import type { Settlement } from "@/lib/settlements/geo";

export type ParticleGroup = { list: Settlement[]; size: number; tone: number };

export function hamletId(s: { la: number; ln: number }) {
  return `${s.la.toFixed(4)},${s.ln.toFixed(4)}`;
}

export type DemoGroup = { list: Settlement[]; size: number; color: string };

// Unchosen hamlets fade. Called hamlets stay small and take their post's colour (red or amber).
// A hamlet a truck reaches is copied onto the road or the end of its branch so the dot stays on
// the line at every zoom. Sizes are globe units, small enough that a province view is not a red field.
export function demoGroups(
  all: Settlement[],
  chosen: Set<string>,
  served: Map<string, { la: number; ln: number; color: string }>,
  urgency?: Map<string, string>,
): DemoGroup[] {
  const unchosen: Settlement[] = [];
  const waiting = new Map<string, Settlement[]>();
  const buckets = new Map<string, Settlement[]>();
  for (const s of all) {
    const id = hamletId(s);
    const hit = served.get(id);
    if (hit) {
      const list = buckets.get(hit.color) ?? [];
      list.push({ ...s, la: hit.la, ln: hit.ln });
      buckets.set(hit.color, list);
      continue;
    }
    if (chosen.has(id)) {
      const color = urgency?.get(id) ?? "rgba(255,72,72,0.8)";
      const list = waiting.get(color) ?? [];
      list.push(s);
      waiting.set(color, list);
    } else unchosen.push(s);
  }
  const groups: DemoGroup[] = [{ list: unchosen, size: 0.006, color: "rgba(226,232,240,0.05)" }];
  for (const [color, list] of waiting) groups.push({ list, size: 0.012, color });
  for (const [color, list] of buckets) groups.push({ list, size: 0.02, color });
  return groups.filter((g) => g.list.length);
}

export function settlementGroups(points: Settlement[]): ParticleGroup[] {
  const small: Settlement[] = [], mid: Settlement[] = [], big: Settlement[] = [], town: Settlement[] = [];
  for (const s of points) {
    const h = s.h ?? (s.n ? 20 : 3);
    (h >= 1500 ? town : h >= 150 ? big : h >= 25 ? mid : small).push(s);
  }
  return [
    { list: small, size: 0.011, tone: 0 },
    { list: mid, size: 0.017, tone: 1 },
    { list: big, size: 0.026, tone: 2 },
    { list: town, size: 0.042, tone: 3 },
  ];
}

// Size scale and opacity per zoom band (23,000 dots over a province-sized patch of screen would
// otherwise fill it white). Changing a band only touches the material.
export function settlementStyle(band: Band) {
  const scale = band === "far" ? 1 : band === "mid" ? 0.8 : 0.55;
  const alpha = band === "far" ? [0.42, 0.5, 0.62, 0.8] : band === "mid" ? [0.4, 0.5, 0.65, 0.85] : [0.6, 0.7, 0.8, 0.9];
  return {
    size: (d: object) => (d as ParticleGroup).size * scale,
    color: (d: object) => `rgba(${(d as ParticleGroup).tone >= 2 ? "248,250,252" : "226,232,240"},${alpha[(d as ParticleGroup).tone]})`,
  };
}

export type ThreeLite = { CanvasTexture: new (c: HTMLCanvasElement) => { needsUpdate: boolean } };

// globe.gl paints a textured point white and ignores particlesColor. The disc itself has to
// carry the colour. A group with almost no alpha (the hamlets Calculate did not pick) gets an
// empty sprite, so those dots leave the picture.
const texCache = new Map<string, { needsUpdate: boolean }>();

function disc(THREE: ThreeLite, key: string, paint: (ctx: CanvasRenderingContext2D) => void) {
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d")!;
  paint(ctx);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  texCache.set(key, tex);
  return tex;
}

export function dotTexture(THREE: ThreeLite) {
  return disc(THREE, "white-freckle", (ctx) => {
    const grd = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.82, "rgba(255,255,255,1)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 32, 32);
  });
}

export function particleTexture(THREE: ThreeLite, group: object) {
  const color = (group as { color?: string }).color;
  if (!color) return dotTexture(THREE);
  const alpha = Number(color.match(/[\d.]+(?=\))/)?.[0] ?? 1);
  if (alpha < 0.25) return disc(THREE, "empty", () => {});
  return disc(THREE, color, (ctx) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(16, 16, 15, 0, Math.PI * 2);
    ctx.fill();
  });
}
