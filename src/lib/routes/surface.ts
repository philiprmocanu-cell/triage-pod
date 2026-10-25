import fs from "node:fs/promises";
import path from "node:path";
import { haversineKm, pairKey, type LatLng } from "./router";

// What the road is made of, for each cached road pair: how many km are paved, gravel or
// dirt/track, from OpenStreetMap's own tags (highway=…, surface=…), keyless.
//
// How: OSRM gives the OSM node ids along the road (annotations=nodes, with the distance between
// each pair); the public OSM API (api.openstreetmap.org/api/0.6/node/<id>/ways) says which ways a
// node belongs to and their tags. The road is sampled every SAMPLE_KM; the way holding both the
// sample node and the next node on the route is the one the truck is on. A way that was already
// fetched covers every later sample inside it, so a 90 km trunk road costs a handful of calls.
// (The Overpass API would do it in one query but overpass-api.de was unreachable from the venue's
// network on 24 Oct 2026 and the mirrors timed out; the OSM API answered in about a second.)
//
// Where OSM has no surface tag the class is assumed from the road class (trunk/primary paved,
// secondary gravel, the rest unpaved) and counted in `assumedKm`, so the panel can say how much is
// a guess. Everything is cached for good in data/surfaces.json, keyed like data/routes.json.

export type SurfaceClass = "paved" | "gravel" | "track";
export type RoadSurface = {
  pavedKm: number;
  gravelKm: number;
  trackKm: number;
  unknownKm: number; // the router gave no nodes for this stretch (straight-line fallback)
  assumedKm: number; // class guessed from highway=… because OSM has no surface tag there
  gravelMeasuredKm: number; // gravel / track km that OSM actually tags as such (not assumed)
  trackMeasuredKm: number;
  worstSurface: SurfaceClass | "unknown";
  totalKm: number;
  samples: number;
  roads: string[]; // the refs / names met along the way, in order
  source: string;
  at: string;
};

const FILE = () => path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "surfaces.json");
const OSRM = process.env.OSRM_URL ?? "https://router.project-osrm.org";
const OSM_API = "https://api.openstreetmap.org/api/0.6";
const SAMPLE_KM = 4, FIRST_SAMPLE_KM = 1; // the first km is town streets: sample them apart from the open road
const OSM_GAP_MS = 250;
const UA = "triage-pod road surface check (demo)";
// A class is the route's worst only when it covers a real stretch of it: a tagged stretch of at
// least WORST_MIN_KM, or (tagged or assumed) at least WORST_MIN_SHARE of the road. The last km of
// town streets at either end, untagged in OSM and assumed "track", must not make a trunk road dirt.
const WORST_MIN_KM = 2, WORST_MIN_SHARE = 0.25;

function worstOf(total: number, gravel: number, gravelMeasured: number, track: number, trackMeasured: number, paved: number): RoadSurface["worstSurface"] {
  const meaningful = (all: number, measured: number) => measured >= WORST_MIN_KM || all >= total * WORST_MIN_SHARE;
  return meaningful(track, trackMeasured) ? "track" : meaningful(gravel, gravelMeasured) ? "gravel" : paved > 0 ? "paved" : track + gravel > 0 ? "track" : "unknown";
}

let cache: Record<string, RoadSurface> | null = null;
let writing: Promise<void> = Promise.resolve();
const inflight = new Map<string, Promise<RoadSurface | null>>();
let queue: Promise<unknown> = Promise.resolve();

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE(), "utf8")) as Record<string, RoadSurface>;
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  writing = writing.then(async () => {
    await fs.mkdir(path.dirname(FILE()), { recursive: true });
    await fs.writeFile(FILE(), JSON.stringify(cache, null, 0));
  }).catch(() => undefined);
  return writing;
}

const PAVED = new Set(["asphalt", "paved", "concrete", "concrete:plates", "concrete:lanes", "chipseal", "paving_stones", "sett", "metal"]);
const GRAVEL = new Set(["gravel", "fine_gravel", "compacted", "pebblestone", "rock", "shells"]);

export function classify(tags: Record<string, string>): { cls: SurfaceClass; assumed: boolean } {
  const s = (tags.surface ?? "").toLowerCase();
  if (s) {
    if (PAVED.has(s)) return { cls: "paved", assumed: false };
    if (GRAVEL.has(s)) return { cls: "gravel", assumed: false };
    return { cls: "track", assumed: false }; // unpaved, dirt, ground, earth, sand, mud, grass, …
  }
  const h = tags.highway ?? "";
  if (/^(motorway|trunk|primary)(_link)?$/.test(h)) return { cls: "paved", assumed: true };
  if (/^secondary(_link)?$/.test(h)) return { cls: "gravel", assumed: true };
  return { cls: "track", assumed: true }; // tertiary, unclassified, residential, track, service
}

type OsmWay = { id: number; nodes: number[]; tags?: Record<string, string> };

async function waysOfNode(id: number): Promise<OsmWay[]> {
  const run = async () => {
    const res = await fetch(`${OSM_API}/node/${id}/ways.json`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
    await new Promise((r) => setTimeout(r, OSM_GAP_MS));
    if (!res.ok) throw new Error(`OSM API ${res.status}`);
    const json = (await res.json()) as { elements: OsmWay[] };
    return json.elements.filter((w) => w.tags?.highway);
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

// The surface of the road between two points, from OSM, or null when the router has no road.
async function measure(a: LatLng, b: LatLng): Promise<RoadSurface | null> {
  const url = `${OSRM}/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=false&annotations=nodes,distance`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const json = (await res.json()) as { code: string; routes?: { distance: number; legs: { annotation: { nodes: number[]; distance: number[] } }[] }[] };
  const leg = json.routes?.[0]?.legs?.[0];
  if (json.code !== "Ok" || !leg) return null;
  const nodes = leg.annotation.nodes, dist = leg.annotation.distance; // dist[i] = metres from node i to i+1
  const total = json.routes![0].distance / 1000;
  const km = { paved: 0, gravel: 0, track: 0, unknown: 0, assumed: 0, gravelMeasured: 0, trackMeasured: 0 };
  const roads: string[] = [];
  const known = new Map<number, OsmWay>(); // way id -> way (nodes + tags), reused for later samples
  let samples = 0;
  let sinceSample = Infinity; // force a sample at the start
  let current: { cls: SurfaceClass; assumed: boolean } | null = null;
  for (let i = 0; i < nodes.length - 1; i++) {
    const segKm = (dist[i] ?? 0) / 1000;
    if (sinceSample >= (samples <= 1 ? FIRST_SAMPLE_KM : SAMPLE_KM)) {
      sinceSample = 0;
      const here = nodes[i], next = nodes[i + 1];
      let way = [...known.values()].find((w) => w.nodes.includes(here) && w.nodes.includes(next)) ?? null;
      if (!way) {
        samples++;
        try {
          const ways = await waysOfNode(here);
          for (const w of ways) known.set(w.id, w);
          way = ways.find((w) => w.nodes.includes(next)) ?? ways[0] ?? null;
        } catch {
          way = null;
        }
      }
      if (way?.tags) {
        current = classify(way.tags);
        const label = way.tags.ref ?? way.tags.name ?? "";
        if (label && roads[roads.length - 1] !== label) roads.push(label);
      }
    }
    if (current) {
      km[current.cls] += segKm;
      if (current.assumed) km.assumed += segKm;
      else if (current.cls === "gravel") km.gravelMeasured += segKm;
      else if (current.cls === "track") km.trackMeasured += segKm;
    } else km.unknown += segKm;
    sinceSample += segKm;
  }
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    pavedKm: r1(km.paved), gravelKm: r1(km.gravel), trackKm: r1(km.track), unknownKm: r1(km.unknown), assumedKm: r1(km.assumed),
    gravelMeasuredKm: r1(km.gravelMeasured), trackMeasuredKm: r1(km.trackMeasured),
    worstSurface: worstOf(total, km.gravel, km.gravelMeasured, km.track, km.trackMeasured, km.paved), totalKm: r1(total), samples, roads: roads.slice(0, 8),
    source: `OpenStreetMap way tags via the OSM API, sampled every ${SAMPLE_KM} km along the OSRM road (${samples} lookups)`,
    at: new Date().toISOString(),
  };
}

// Cached answer for a pair, or null (never blocks on the network).
export async function cachedSurface(a: LatLng, b: LatLng): Promise<RoadSurface | null> {
  const c = await load();
  return c[pairKey(a, b)] ?? c[pairKey(b, a)] ?? null;
}

// Fetch and cache the surface for a pair; concurrent callers share one measurement.
export async function roadSurface(a: LatLng, b: LatLng, opts: { refresh?: boolean } = {}): Promise<RoadSurface | null> {
  if (haversineKm(a, b) < 0.05) return null;
  const k = pairKey(a, b);
  const c = await load();
  if (!opts.refresh && c[k]) return c[k];
  if (!inflight.has(k)) {
    inflight.set(k, (async () => {
      try {
        const s = await measure(a, b);
        if (s) {
          c[k] = s;
          await save();
        }
        return s;
      } finally {
        inflight.delete(k);
      }
    })());
  }
  return inflight.get(k)!;
}

// Start a measurement in the background (the planner does this when it meets a road it has not
// measured yet, so the first plan is not held up by thirty OSM lookups).
export function surfaceSoon(a: LatLng, b: LatLng) {
  roadSurface(a, b).catch(() => undefined);
}

// Sum several legs (a multi-stop run) into one breakdown; null when any leg is unmeasured.
export function sumSurfaces(parts: (RoadSurface | null)[]): RoadSurface | null {
  if (!parts.length || parts.some((p) => !p)) return null;
  const ps = parts as RoadSurface[];
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const sum = (f: (p: RoadSurface) => number) => r1(ps.reduce((s, p) => s + f(p), 0));
  const total = sum((p) => p.totalKm);
  const track = sum((p) => p.trackKm), gravel = sum((p) => p.gravelKm), paved = sum((p) => p.pavedKm);
  const trackM = sum((p) => p.trackMeasuredKm ?? 0), gravelM = sum((p) => p.gravelMeasuredKm ?? 0);
  return {
    pavedKm: paved, gravelKm: gravel, trackKm: track, unknownKm: sum((p) => p.unknownKm), assumedKm: sum((p) => p.assumedKm), gravelMeasuredKm: gravelM, trackMeasuredKm: trackM,
    worstSurface: worstOf(total, gravel, gravelM, track, trackM, paved), totalKm: total, samples: ps.reduce((s, p) => s + p.samples, 0),
    roads: [...new Set(ps.flatMap((p) => p.roads))].slice(0, 8), source: ps[0].source, at: ps.map((p) => p.at).sort()[0],
  };
}

// "85.8 km: 60 paved, 26 gravel" for the panel.
export function describeSurface(s: RoadSurface) {
  const parts: string[] = [];
  if (s.pavedKm) parts.push(`${Math.round(s.pavedKm)} paved`);
  if (s.gravelKm) parts.push(`${Math.round(s.gravelKm)} gravel`);
  if (s.trackKm) parts.push(`${Math.round(s.trackKm)} dirt/track`);
  if (s.unknownKm) parts.push(`${Math.round(s.unknownKm)} unknown`);
  return `${s.totalKm} km: ${parts.join(", ")}${s.assumedKm >= 1 ? ` (${Math.round(s.assumedKm)} km assumed from the road class)` : ""}`;
}

export async function allSurfaces() {
  return { ...(await load()) };
}
