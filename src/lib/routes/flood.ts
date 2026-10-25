import fs from "node:fs/promises";
import path from "node:path";
import type { LatLng } from "./router";
import type { RoadSurface, SurfaceClass } from "./surface";

// Flood risk on one leg. Asks the weather agent's GET /api/weather/road?from=lat,lng&to=lat,lng
// (contract: { risk: low|medium|high, reasons: string[] }). While that route does not exist yet
// (404 / connection refused) the answer is "low" with a note saying so, never a guess.
// On top of that sits the test switch on the Routes page ("Flood the Katete road"): a list of
// villages whose roads are under water, kept in data/floods.json so every request and the page
// see the same thing. A leg that starts or ends within 25 km of a flooded village is high.

export type FloodRisk = "low" | "medium" | "high";
export type FloodCheck = {
  risk: FloodRisk;
  reasons: string[];
  stubbed: boolean;
  forced: boolean;
  weatherRisk: FloodRisk; // what the weather alone said, before the road surface is counted
  wettestWindowMm: number; // the wettest forecast day on the worst sample of the leg
  rain72hMm: number;
  surface: SurfaceClass | "unknown" | null; // null = not measured yet
};

// Rain enough to make a dirt road matter: half the warning mark in src/lib/weather/model.ts (20 mm).
export const SURFACE_RAIN_MM = 10;

const FILE = () => path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "floods.json");
const NEAR_KM = 25;

type Forced = { villages: { name: string; lat: number; lng: number; since: string }[] };

async function readForced(): Promise<Forced> {
  try {
    return JSON.parse(await fs.readFile(FILE(), "utf8")) as Forced;
  } catch {
    return { villages: [] };
  }
}

export async function forcedFloods() {
  return (await readForced()).villages;
}

// Switch a village's road under water (on) or dry again (off).
export async function setForcedFlood(v: { name: string; lat: number; lng: number }, on: boolean) {
  const f = await readForced();
  f.villages = f.villages.filter((x) => x.name.toLowerCase() !== v.name.toLowerCase());
  if (on) f.villages.push({ ...v, since: new Date().toISOString() });
  await fs.mkdir(path.dirname(FILE()), { recursive: true });
  await fs.writeFile(FILE(), JSON.stringify(f, null, 2));
  return f.villages;
}

function km(a: LatLng, b: LatLng) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const RANK: Record<FloodRisk, number> = { low: 0, medium: 1, high: 2 };

const UP: Record<FloodRisk, FloodRisk> = { low: "medium", medium: "high", high: "high" };

// A dirt or track road under the same rain scores one level worse than a paved one: the weather
// route judges the sky, this judges what is under the wheels. Only when there is rain to speak of
// (≥ SURFACE_RAIN_MM on the wettest day of the window, or a medium/high weather risk already):
// a dry-season dirt road is just a slow road.
export function applySurface(check: FloodCheck, surface: RoadSurface | null): FloodCheck {
  const out: FloodCheck = { ...check, reasons: [...check.reasons], surface: surface?.worstSurface ?? null };
  if (!surface) return out;
  if (surface.worstSurface !== "track" && surface.worstSurface !== "gravel") return out;
  const km = surface.worstSurface === "track" ? surface.trackKm : surface.gravelKm;
  const wetEnough = check.weatherRisk !== "low" || check.wettestWindowMm >= SURFACE_RAIN_MM || check.rain72hMm >= SURFACE_RAIN_MM;
  if (!wetEnough || check.forced) return out;
  // Dirt/track: one level worse whenever it rains. Gravel holds light rain: one level worse only
  // once the weather itself is already medium.
  if (surface.worstSurface === "track" || check.weatherRisk === "medium") {
    out.risk = UP[check.risk];
    out.reasons.push(`${Math.round(km)} km of ${surface.worstSurface === "track" ? "dirt/track" : "gravel"} road (OpenStreetMap${surface.assumedKm >= km / 2 ? ", surface assumed from the road class" : ""}) under this rain: one level worse than a paved road`);
  }
  return out;
}

// `origin` is this app's own address (the weather route lives in the same Next server).
// `surface` (when the road has been measured, see surface.ts) makes an unpaved leg score worse.
export async function floodRisk(from: LatLng, to: LatLng, origin: string, surface: RoadSurface | null = null): Promise<FloodCheck> {
  const out: FloodCheck = { risk: "low", reasons: [], stubbed: false, forced: false, weatherRisk: "low", wettestWindowMm: 0, rain72hMm: 0, surface: null };
  try {
    const res = await fetch(`${origin}/api/weather/road?from=${from[0]},${from[1]}&to=${to[0]},${to[1]}`, { signal: AbortSignal.timeout(6000), cache: "no-store" });
    if (res.status === 404) {
      out.stubbed = true;
      out.reasons.push("weather check not available yet (no /api/weather/road): assumed low");
    } else if (!res.ok) {
      out.stubbed = true;
      out.reasons.push(`weather check answered ${res.status}: assumed low`);
    } else {
      const j = (await res.json()) as { risk?: string; reasons?: string[]; samples?: { wettestWindowMm?: number; rain72hMm?: number }[] };
      const r = (["low", "medium", "high"] as FloodRisk[]).includes(j.risk as FloodRisk) ? (j.risk as FloodRisk) : "low";
      out.risk = r;
      out.weatherRisk = r;
      out.reasons.push(...(j.reasons ?? []));
      out.wettestWindowMm = Math.max(0, ...(j.samples ?? []).map((s) => s.wettestWindowMm ?? 0));
      out.rain72hMm = Math.max(0, ...(j.samples ?? []).map((s) => s.rain72hMm ?? 0));
    }
  } catch (e) {
    out.stubbed = true;
    out.reasons.push(`weather check unreachable (${(e as Error).message.slice(0, 60)}): assumed low`);
  }
  for (const v of (await readForced()).villages) {
    const near = Math.min(km(from, [v.lat, v.lng]), km(to, [v.lat, v.lng]));
    if (near <= NEAR_KM) {
      out.forced = true;
      if (RANK[out.risk] < RANK.high) out.risk = "high";
      out.reasons.push(`${v.name} road flooded (test switch on the Routes page)`);
    }
  }
  return applySurface(out, surface);
}
