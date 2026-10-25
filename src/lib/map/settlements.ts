// The 23,000 settlement dots as one particles layer (one GPU draw, no DOM), shared by the globe
// pages. Four groups by size (roofs) so a bigger village is a bigger dot; sizes are in globe units
// with perspective so a hamlet is under a pixel far out and a few pixels up close. The dots sit at
// altitude 0: point sprites are centred on their vertex, so size never moves the centre, and at
// ground level they stay on their pixel when the view is oblique.

import type { Band } from "./pin";
import type { Settlement } from "@/lib/settlements/geo";

export type ParticleGroup = { list: Settlement[]; size: number; tone: number };

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
  const alpha = band === "far" ? [0.22, 0.3, 0.45, 0.7] : band === "mid" ? [0.4, 0.5, 0.65, 0.85] : [0.6, 0.7, 0.8, 0.9];
  return {
    size: (d: object) => (d as ParticleGroup).size * scale,
    color: (d: object) => `rgba(${(d as ParticleGroup).tone >= 2 ? "248,250,252" : "226,232,240"},${alpha[(d as ParticleGroup).tone]})`,
  };
}

export type ThreeLite = { CanvasTexture: new (c: HTMLCanvasElement) => { needsUpdate: boolean } };

// A soft round sprite for the dots (points are square without one).
export function dotTexture(THREE: ThreeLite) {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d")!;
  const grd = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.55, "rgba(255,255,255,1)");
  grd.addColorStop(0.75, "rgba(255,255,255,0.6)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}
