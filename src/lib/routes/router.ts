import fs from "node:fs/promises";
import path from "node:path";

// A road path between two points, for the route planner. Three sources, in order:
//   1. Google Routes API, when GOOGLE_MAPS_API_KEY is set in .env.local (it is not today);
//   2. the public OSRM demo server (keyless, rate-limited: one request at a time, a pause
//      between them, and every pair cached for good in data/routes.json);
//   3. a straight line, with the distance stretched by 1.5 (what the delivery module already
//      assumes for roads), when neither answers.
// Points are [lat, lng]. Distances are road km; `drivingMinutes` is what the router thought a car
// takes, carriers get their own time from their speed (see minutesFor).

export type LatLng = [number, number];
export type RoadPath = {
  points: LatLng[];
  km: number;
  drivingMinutes: number;
  source: "google" | "osrm" | "straight";
  summary: string; // the main road names the router gave, or ''
};
export type RoadOptions = { alternatives?: boolean };

const CACHE_FILE = () => path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "routes.json");
const OSRM = process.env.OSRM_URL ?? "https://router.project-osrm.org";
const OSRM_GAP_MS = 400; // be polite to the demo server
const MAX_STORED_POINTS = 160; // enough to follow the road on screen, small enough for a table cell

type CacheEntry = { main: RoadPath; alternatives?: RoadPath[]; at: string };
let cache: Record<string, CacheEntry> | null = null;
let cacheWrite: Promise<void> = Promise.resolve();
let osrmQueue: Promise<unknown> = Promise.resolve();

const key = (a: LatLng, b: LatLng) => `${a[0].toFixed(4)},${a[1].toFixed(4)}|${b[0].toFixed(4)},${b[1].toFixed(4)}`;
export const pairKey = key; // shared with the surface cache (data/surfaces.json) so both files line up

// Every pair the road cache knows, as [from, to] points (for warming the surface cache).
export async function cachedPairs(): Promise<[LatLng, LatLng][]> {
  const c = await loadCache();
  return Object.keys(c).map((k) => k.split("|").map((p) => p.split(",").map(Number) as LatLng) as [LatLng, LatLng]);
}

async function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(CACHE_FILE(), "utf8")) as Record<string, CacheEntry>;
  } catch {
    cache = {};
  }
  return cache;
}

// The cache is a few MB once every post-to-post pair is in it, so writes are coalesced: one file
// write at most every SAVE_EVERY_MS, however many pairs landed in between (a planning run can add
// dozens of alternative roads in a few seconds).
const SAVE_EVERY_MS = 2000;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveWaiters: (() => void)[] = [];
function saveCache(): Promise<void> {
  return new Promise<void>((resolve) => {
    saveWaiters.push(resolve);
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const waiters = saveWaiters;
      saveWaiters = [];
      cacheWrite = cacheWrite
        .then(async () => {
          await fs.mkdir(path.dirname(CACHE_FILE()), { recursive: true });
          await fs.writeFile(CACHE_FILE(), JSON.stringify(cache, null, 0));
        })
        .catch(() => undefined)
        .then(() => { for (const w of waiters) w(); });
    }, SAVE_EVERY_MS);
  });
}

export function haversineKm(a: LatLng, b: LatLng) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Keep every Nth point so a long road still fits in one table cell; endpoints always stay.
export function thin(points: LatLng[], max = MAX_STORED_POINTS): LatLng[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: LatLng[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

// How long a carrier takes on this path, with a floor so a walk across the village is never 0.
export function minutesFor(km: number, speedKmh: number) {
  return Math.max(3, Math.round((km / Math.max(1, speedKmh)) * 60));
}

function straight(a: LatLng, b: LatLng): RoadPath {
  const km = haversineKm(a, b) * 1.5;
  return { points: [a, b], km: round1(km), drivingMinutes: minutesFor(km, 40), source: "straight", summary: "" };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

async function google(a: LatLng, b: LatLng, alternatives: boolean): Promise<{ main: RoadPath; alternatives: RoadPath[] } | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.description,routes.polyline.geoJsonLinestring",
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: a[0], longitude: a[1] } } },
      destination: { location: { latLng: { latitude: b[0], longitude: b[1] } } },
      travelMode: "DRIVE",
      computeAlternativeRoutes: alternatives,
      polylineEncoding: "GEO_JSON_LINESTRING",
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Google Routes ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { routes?: { distanceMeters: number; duration: string; description?: string; polyline: { geoJsonLinestring: { coordinates: [number, number][] } } }[] };
  const routes = (json.routes ?? []).map((r) => ({
    points: r.polyline.geoJsonLinestring.coordinates.map(([lng, lat]) => [lat, lng] as LatLng),
    km: round1(r.distanceMeters / 1000),
    drivingMinutes: Math.round(parseFloat(r.duration) / 60),
    source: "google" as const,
    summary: r.description ?? "",
  }));
  if (!routes.length) return null;
  return { main: routes[0], alternatives: routes.slice(1) };
}

async function osrm(a: LatLng, b: LatLng, alternatives: boolean): Promise<{ main: RoadPath; alternatives: RoadPath[] } | null> {
  const run = async () => {
    const url = `${OSRM}/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson${alternatives ? "&alternatives=true" : ""}`;
    const res = await fetch(url, { headers: { "User-Agent": "triage-pod route planner (demo)" }, signal: AbortSignal.timeout(10000) });
    await new Promise((r) => setTimeout(r, OSRM_GAP_MS));
    if (!res.ok) throw new Error(`OSRM ${res.status}`);
    const json = (await res.json()) as { code: string; routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] }; legs: { summary: string }[] }[] };
    if (json.code !== "Ok" || !json.routes?.length) return null;
    const routes = json.routes.map((r) => ({
      points: r.geometry.coordinates.map(([lng, lat]) => [lat, lng] as LatLng),
      km: round1(r.distance / 1000),
      drivingMinutes: Math.round(r.duration / 60),
      source: "osrm" as const,
      summary: r.legs[0]?.summary ?? "",
    }));
    return { main: routes[0], alternatives: routes.slice(1) };
  };
  // One OSRM request at a time, whoever asks.
  const p = osrmQueue.then(run, run);
  osrmQueue = p.catch(() => undefined);
  return p;
}

// The road between two points. Cached per pair; the alternatives are fetched only when asked
// for (a flooded leg) and then cached too.
export async function roadPath(a: LatLng, b: LatLng, opts: RoadOptions = {}): Promise<{ main: RoadPath; alternatives: RoadPath[] }> {
  if (haversineKm(a, b) < 0.05) return { main: { points: [a, b], km: 0, drivingMinutes: 0, source: "straight", summary: "same place" }, alternatives: [] };
  const c = await loadCache();
  const k = key(a, b);
  const hit = c[k];
  if (hit && hit.main.source !== "straight" && (!opts.alternatives || hit.alternatives)) return { main: hit.main, alternatives: hit.alternatives ?? [] };
  let got: { main: RoadPath; alternatives: RoadPath[] } | null = null;
  try {
    got = await google(a, b, !!opts.alternatives);
  } catch (e) {
    console.warn("[routes] Google Routes failed, trying OSRM:", (e as Error).message);
  }
  if (!got) {
    try {
      got = await osrm(a, b, !!opts.alternatives);
    } catch (e) {
      console.warn("[routes] OSRM failed, straight line:", (e as Error).message);
    }
  }
  if (!got) return { main: hit?.main ?? straight(a, b), alternatives: hit?.alternatives ?? [] };
  const entry: CacheEntry = { main: { ...got.main, points: thin(got.main.points) }, at: new Date().toISOString() };
  if (opts.alternatives) entry.alternatives = got.alternatives.map((r) => ({ ...r, points: thin(r.points) }));
  else if (hit?.alternatives) entry.alternatives = hit.alternatives;
  c[k] = entry;
  void saveCache(); // coalesced write; the in-memory cache is already current
  return { main: entry.main, alternatives: entry.alternatives ?? [] };
}

// Which source will answer today, for the page and the docs.
export function routerSource(): "google" | "osrm" {
  return process.env.GOOGLE_MAPS_API_KEY ? "google" : "osrm";
}

// Fill the cache for the pairs the planner will need most: the hub to every post, then
// post-to-post for the pairs asked for. Sequential and polite; safe to call again (cache hits
// cost nothing).
export async function warmRoutes(points: { id: number; lat: number; lng: number; hub: boolean }[], pairs: "hub" | "all" = "hub") {
  const hub = points.find((p) => p.hub) ?? points[0];
  const todo: [LatLng, LatLng][] = [];
  for (const p of points) if (p.id !== hub.id) todo.push([[hub.lat, hub.lng], [p.lat, p.lng]]);
  if (pairs === "all") for (const a of points) for (const b of points) if (a.id < b.id && a.id !== hub.id && b.id !== hub.id) todo.push([[a.lat, a.lng], [b.lat, b.lng]]);
  let fetched = 0, cached = 0, straightLines = 0;
  for (const [a, b] of todo) {
    const c = await loadCache();
    if (c[key(a, b)] && c[key(a, b)].main.source !== "straight") { cached++; continue; }
    const r = await roadPath(a, b);
    if (r.main.source === "straight") straightLines++; else fetched++;
  }
  return { pairs: todo.length, fetched, cached, straightLines };
}

export async function cachedRouteCount() {
  return Object.keys(await loadCache()).length;
}
