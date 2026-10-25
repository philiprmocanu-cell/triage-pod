// Route drawing for the satellite page: one hairline per unique run, a distinct shade per
// corridor, red only where flood risk is high. Fat overlapping copies of the same restock
// batch are collapsed by geometry so the map stays readable in a demo.

import type { Band } from "./pin";
import type { SettlementIndex } from "@/lib/settlements/geo";
import { kmBetween } from "@/lib/settlements/geo";

export const KIND_COLOR: Record<string, string> = {
  truck: "#d6c4a8",
  pickup: "#c4b49a",
  motorbike: "#9eb6c4",
  bicycle: "#a8b8a4",
  boat: "#8eb8c0",
  drone: "#b8acc8",
};
export const KIND_WORD: Record<string, string> = {
  truck: "Truck",
  pickup: "Pickup",
  motorbike: "Motorbike",
  bicycle: "Bicycle",
  boat: "Boat",
  drone: "Drone (proposed)",
};
export const FLOOD_COLOR = "#ef4444";
export const UNKNOWN_COLOR = "#d8d8d8";

// Distinct shades so two corridors can sit next to each other without blending into one fat line.
const RUN_PALETTE = [
  "#e8e4dc",
  "#c9b89a",
  "#9bb0c4",
  "#b7c4ae",
  "#c4a484",
  "#8aa3b0",
  "#d2c2b0",
  "#7f9a8c",
  "#b8a090",
  "#a0b8c8",
  "#c8c0a8",
  "#8c9aa8",
];

export function shadeOf(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 33 + key.charCodeAt(i)) >>> 0;
  return RUN_PALETTE[h % RUN_PALETTE.length];
}

export function geomKey(pts: [number, number][]): string {
  if (pts.length < 2) return "";
  const a = pts[0], b = pts[pts.length - 1], mid = pts[Math.floor(pts.length / 2)];
  const r = (n: number) => n.toFixed(3);
  return `${pts.length}:${r(a[0])},${r(a[1])}>${r(mid[0])},${r(mid[1])}>${r(b[0])},${r(b[1])}`;
}

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

export type RouteState = "planned" | "moving" | "done" | "picked" | "dim";

export function routeColor(kind: string | undefined, flood: string, state: RouteState, runKey?: string): string {
  if (flood === "high") return withAlpha(FLOOD_COLOR, state === "picked" ? 1 : 0.9);
  const hex = (runKey ? shadeOf(runKey) : null) ?? KIND_COLOR[kind ?? ""] ?? UNKNOWN_COLOR;
  const alpha = state === "picked" ? 1 : state === "moving" ? 0.92 : state === "planned" ? 0.78 : state === "done" ? 0.22 : 0.14;
  return withAlpha(hex, alpha);
}

// Hairlines. globe.gl stroke is in pixels; 3px used to look like a painted highway.
export function routeStroke(band: Band, state: RouteState): number {
  const base = band === "far" ? 0.85 : band === "mid" ? 0.7 : 0.55;
  if (state === "picked") return base + 0.7;
  if (state === "moving") return base + 0.15;
  if (state === "done" || state === "dim") return Math.max(0.4, base - 0.2);
  return base;
}

export function withAlpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(2)})`;
}

export function offsetPath(pts: [number, number][], key: string): [number, number][] {
  if (pts.length < 2) return pts;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 33 + key.charCodeAt(i)) >>> 0;
  const slot = (h % 7) - 3;
  if (!slot) return pts;
  const meters = slot * 80;
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const latm = 111_320;
    const lngm = 111_320 * Math.cos((p[0] * Math.PI) / 180);
    const nx = -(b[1] - a[1]) * lngm;
    const ny = (b[0] - a[0]) * latm;
    const len = Math.hypot(nx, ny) || 1;
    return [p[0] + (ny / len) * (meters / latm), p[1] + (nx / len) * (meters / lngm)] as [number, number];
  });
}

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

// Named hamlets sitting on a planned road, so the line is visibly going through villages.
export function hamletsAlong(pts: [number, number][], index: SettlementIndex | null, everyKm = 7, withinKm = 1.6) {
  if (!index || pts.length < 2) return [] as { la: number; ln: number; n: string }[];
  const out: { la: number; ln: number; n: string }[] = [];
  const seen = new Set<string>();
  let acc = 0;
  let next = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += kmBetween(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    if (acc < next) continue;
    next += everyKm;
    const hit = index.nearest(pts[i][0], pts[i][1], withinKm, true);
    if (!hit?.n) continue;
    const k = `${hit.la.toFixed(3)},${hit.ln.toFixed(3)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ la: hit.la, ln: hit.ln, n: hit.n });
  }
  return out;
}
