// Route drawing shared by the live map (/globe) and the routes page (/routes): one colour per
// carrier kind, red where the flood check said high, thicker lines far out and thinner close in,
// dashes that move while the carrier moves, dim lines once delivered.

import type { Band } from "./pin";

export const KIND_COLOR: Record<string, string> = { truck: "#f59e0b", pickup: "#fb923c", motorbike: "#38bdf8", bicycle: "#34d399", boat: "#22d3ee", drone: "#a78bfa" };
export const KIND_WORD: Record<string, string> = { truck: "Truck", pickup: "Pickup", motorbike: "Motorbike", bicycle: "Bicycle", boat: "Boat", drone: "Drone (proposed)" };
export const FLOOD_COLOR = "#ef4444";
export const UNKNOWN_COLOR = "#e2e8f0";

// A multi-stop run writes "run A stop 2 of 4 (Chipata → Katete → …)" in every order's reason.
const RUN_RE = /run ([A-Z0-9]+) stop (\d+) of (\d+) \(([^)]+)\)/;
export const runOf = (reason: string) => {
  const m = RUN_RE.exec(reason);
  return m ? { key: `${m[1]}|${m[4]}`, id: m[1], stop: Number(m[2]), of: Number(m[3]), tour: m[4] } : null;
};

export function parseWaypoints(json: string): [number, number][] {
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1]]);
  } catch {
    return [];
  }
}

// The line colour: red when flooded, else the carrier's colour; alpha by state so thirty routes stay readable.
export type RouteState = "planned" | "moving" | "done" | "picked" | "dim";
export function routeColor(kind: string | undefined, flood: string, state: RouteState): string {
  const hex = flood === "high" ? FLOOD_COLOR : KIND_COLOR[kind ?? ""] ?? UNKNOWN_COLOR;
  const alpha = state === "picked" ? 1 : state === "moving" ? 0.95 : state === "planned" ? 0.8 : state === "done" ? 0.28 : 0.18;
  return withAlpha(hex, alpha);
}

// Stroke in pixels (fat lines): thick enough to read from across the province, thinner up close.
export function routeStroke(band: Band, state: RouteState): number {
  const base = band === "far" ? 3 : band === "mid" ? 2.4 : 1.8;
  if (state === "picked") return base + 1.8;
  if (state === "moving") return base + 0.8;
  if (state === "done" || state === "dim") return Math.max(1, base - 1.4);
  return base;
}

export function withAlpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(2)})`;
}

// Distance-weighted position a fraction t along a polyline of [lat, lng] points.
export function alongPath(points: [number, number][], t: number): [number, number] {
  if (points.length < 2) return points[0] ?? [0, 0];
  if (t <= 0) return points[0];
  if (t >= 1) return points[points.length - 1];
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - points[i - 1][0], (points[i][1] - points[i - 1][1]) * Math.cos((points[i][0] * Math.PI) / 180));
    seg.push(d);
    total += d;
  }
  let want = t * total;
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i]) {
      const f = seg[i] ? want / seg[i] : 0;
      return [points[i][0] + (points[i + 1][0] - points[i][0]) * f, points[i][1] + (points[i + 1][1] - points[i][1]) * f];
    }
    want -= seg[i];
  }
  return points[points.length - 1];
}
