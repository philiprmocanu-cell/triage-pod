import fs from "node:fs/promises";
import path from "node:path";
import { sqlRows } from "@/lib/spacetime";
import type { LatLng } from "./router";
import type { RoadSurface, SurfaceClass } from "./surface";

// Flood risk on one leg. Asks the weather agent's GET /api/weather/road?from=lat,lng&to=lat,lng
// (contract: { risk: low|medium|high, reasons: string[] }). While that route does not exist yet
// (404 / connection refused) the answer is "low" with a note saying so, never a guess.
// On top of that sit two overrides:
//   - the test switch on the Routes page ("Flood the Katete road"): a list of villages whose roads
//     are under water, kept in data/floods.json; a leg that starts or ends within 25 km of a
//     flooded village is high;
//   - the `road_block` table in SpacetimeDB (the crisis drill writes it; a district officer could
//     too): one row per blocked leg between two posts, with a level and a reason, until a time. A
//     leg whose two ends are the block's two posts (either way round, within BLOCK_MATCH_KM) takes
//     the block's level. The alternative road the router offers is a different road, so its halves
//     do not match the block and can pass; a carrier that does not need the road (motorbike, boat)
//     is the next step (planner.ts).

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
  blocked?: { from: string; to: string; risk: FloodRisk; reason: string } | null; // the road_block row that hit this leg
};

// Rain enough to make a dirt road matter: half the warning mark in src/lib/weather/model.ts (20 mm).
export const SURFACE_RAIN_MM = 10;

const FILE = () => path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "floods.json");
const NEAR_KM = 25;
const BLOCK_MATCH_KM = 12; // a leg end counts as "at" the block's post within this
const BLOCK_CACHE_MS = 1500; // the planner asks hundreds of times per run; the table changes rarely

export type RoadBlock = { id: number; fromVillageId: number; toVillageId: number; from: string; to: string; fromAt: LatLng; toAt: LatLng; risk: FloodRisk; reason: string; until: string };

let blockCache: { at: number; blocks: RoadBlock[] } | null = null;

// Every road_block row that has not expired, with its posts' names and positions.
export async function roadBlocks(): Promise<RoadBlock[]> {
  if (blockCache && Date.now() - blockCache.at < BLOCK_CACHE_MS) return blockCache.blocks;
  let blocks: RoadBlock[] = [];
  try {
    const [rows, villages] = await Promise.all([
      sqlRows<{ id: number; leg_from_village_id: number; leg_to_village_id: number; risk: string; reason: string; until: unknown }>("SELECT * FROM road_block"),
      sqlRows<{ id: number; name: string; lat: number; lng: number }>("SELECT id, name, lat, lng FROM village"),
    ]);
    const vmap = new Map(villages.map((v) => [Number(v.id), v]));
    const now = Date.now();
    blocks = rows.flatMap((r) => {
      const a = vmap.get(Number(r.leg_from_village_id)), b = vmap.get(Number(r.leg_to_village_id));
      const untilMs = Array.isArray(r.until) ? Number((r.until as number[])[0]) / 1000 : 0;
      if (!a || !b || (untilMs && untilMs < now)) return [];
      const risk: FloodRisk = r.risk === "medium" ? "medium" : "high";
      return [{ id: Number(r.id), fromVillageId: a.id, toVillageId: b.id, from: a.name.replace(/ \(.*\)$/, ""), to: b.name.replace(/ \(.*\)$/, ""), fromAt: [a.lat, a.lng] as LatLng, toAt: [b.lat, b.lng] as LatLng, risk, reason: String(r.reason), until: untilMs ? new Date(untilMs).toISOString() : "" }];
    });
  } catch {
    blocks = blockCache?.blocks ?? []; // the table is not published or the database is down: no blocks
  }
  blockCache = { at: Date.now(), blocks };
  return blocks;
}

// The block that sits on this leg, if any (either direction).
export function blockOn(from: LatLng, to: LatLng, blocks: RoadBlock[]): RoadBlock | null {
  for (const b of blocks) {
    const straight = km(from, b.fromAt) <= BLOCK_MATCH_KM && km(to, b.toAt) <= BLOCK_MATCH_KM;
    const back = km(from, b.toAt) <= BLOCK_MATCH_KM && km(to, b.fromAt) <= BLOCK_MATCH_KM;
    if (straight || back) return b;
  }
  return null;
}

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

// The weather route's answer for a leg is kept for WEATHER_MEMO_MS: a planning run asks about
// the same pair dozens of times (every order to one post, every re-check), and the forecast
// behind it is cached for three hours anyway. The test switch, the road_block table and the
// surface are applied fresh on every call.
const WEATHER_MEMO_MS = 30_000;
const weatherMemo = new Map<string, { at: number; check: Promise<FloodCheck> }>();

// `origin` is this app's own address (the weather route lives in the same Next server).
// `surface` (when the road has been measured, see surface.ts) makes an unpaved leg score worse.
export async function floodRisk(from: LatLng, to: LatLng, origin: string, surface: RoadSurface | null = null): Promise<FloodCheck> {
  const key = `${from[0].toFixed(4)},${from[1].toFixed(4)}|${to[0].toFixed(4)},${to[1].toFixed(4)}`;
  let m = weatherMemo.get(key);
  if (!m || Date.now() - m.at > WEATHER_MEMO_MS) {
    m = { at: Date.now(), check: weatherOnly(from, to, origin) };
    weatherMemo.set(key, m);
    if (weatherMemo.size > 2000) for (const [k, v] of weatherMemo) if (Date.now() - v.at > WEATHER_MEMO_MS) weatherMemo.delete(k);
  }
  const w = await m.check;
  const out: FloodCheck = { ...w, reasons: [...w.reasons] };
  for (const v of (await readForced()).villages) {
    const near = Math.min(km(from, [v.lat, v.lng]), km(to, [v.lat, v.lng]));
    if (near <= NEAR_KM) {
      out.forced = true;
      if (RANK[out.risk] < RANK.high) out.risk = "high";
      out.reasons.push(`${v.name} road flooded (test switch on the Routes page)`);
    }
  }
  // A road the province has marked blocked (road_block table) wins over the forecast on that leg.
  const block = blockOn(from, to, await roadBlocks());
  if (block) {
    out.forced = true;
    out.blocked = { from: block.from, to: block.to, risk: block.risk, reason: block.reason };
    if (RANK[out.risk] < RANK[block.risk]) out.risk = block.risk;
    out.reasons.unshift(`${block.from} → ${block.to} road ${block.risk === "high" ? "blocked" : "at risk"}: ${block.reason}${block.until ? ` (until ${block.until.slice(0, 16).replace("T", " ")}Z)` : ""}`);
  }
  return applySurface(out, surface);
}

async function weatherOnly(from: LatLng, to: LatLng, origin: string): Promise<FloodCheck> {
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
  if (out.stubbed) weatherMemo.delete(`${from[0].toFixed(4)},${from[1].toFixed(4)}|${to[0].toFixed(4)},${to[1].toFixed(4)}`); // ask again next time
  return out;
}
