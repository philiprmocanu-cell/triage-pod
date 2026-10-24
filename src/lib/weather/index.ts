import { promises as fs } from "fs";
import path from "path";
import { sites, type Site } from "./sites";
import { fetchForecast, fetchRiver, type CellForecast, type CellRiver } from "./openmeteo";
import { fetchFloodRaster, floodNear, type FloodRaster, type FloodNear } from "./gibs";
import { summarizeRain, riverRise, cutOff, floodRiskToday, floodRisk14d, malariaOutlook, sampleRisk, worst, type Risk, type RainSummary, type RiverRise, type CutOff } from "./model";

// The weather the dispatcher plans trucks by: what fell, what is forecast, how the rivers stand
// and what the satellite sees under water right now, for every health post and for any point on
// a road. Three free sources, each fetched at most every three hours and kept in memory and on
// disk (data/weather.json) so the venue keeps answering on slow internet. A source that fails
// keeps its last good copy and says so in `errors`; nothing here ever blocks the page beyond the
// 15 s per-call timeout, and callers that already hold a copy get it at once.
//
// Grid: Open-Meteo answers for 0.25° cells (about 28 km), so neighbouring posts share one cell
// and all 40 posts fit in two batched requests. The NASA flood picture covers the whole province.
//
// Optional later: NASA_EARTHDATA_TOKEN (an Earthdata Login bearer token) would unlock the raw
// 250 m LANCE flood product and the finished POWER data sooner; nothing needs it today.

export const TTL_MS = 3 * 3600_000;
const CELL_DEG = 0.25;
const POST_RADIUS_KM = 10; // how far around a post the flood map is read
const ROAD_RADIUS_KM = 5;
const DISK = () => path.join(process.env.DATA_DIR ?? "data", "weather.json");

type Store = {
  forecast?: { at: number; cells: Record<string, CellForecast> };
  river?: { at: number; cells: Record<string, CellRiver> };
  flood?: { at: number; raster: FloodRaster };
  errors: Record<string, string>;
};

export type Weather = { store: Store; sites: Site[]; fetchedAt: string; sources: string[]; preliminary: string; errors: Record<string, string> };

let store: Store | null = null;
let inflight: Promise<Weather> | null = null;

export const cellOf = (lat: number, lng: number) => ({ lat: Math.round(lat / CELL_DEG) * CELL_DEG, lng: Math.round(lng / CELL_DEG) * CELL_DEG });
export const cellKey = (c: { lat: number; lng: number }) => `${c.lat}|${c.lng}`;
const todayIso = () => new Date().toISOString().slice(0, 10);
const yesterdayIso = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

async function fromDisk(): Promise<Store | null> {
  try {
    const s = JSON.parse(await fs.readFile(DISK(), "utf8")) as Store;
    return s && typeof s === "object" ? { ...s, errors: s.errors ?? {} } : null;
  } catch {
    return null;
  }
}

function toDisk(s: Store) {
  fs.mkdir(path.dirname(DISK()), { recursive: true })
    .then(() => fs.writeFile(DISK(), JSON.stringify(s)))
    .catch(() => {});
}

function bboxOf(list: Site[]) {
  const pad = 0.3, r = (x: number) => Math.round(x * 20) / 20;
  return {
    south: r(Math.min(...list.map((s) => s.lat)) - pad),
    north: r(Math.max(...list.map((s) => s.lat)) + pad),
    west: r(Math.min(...list.map((s) => s.lng)) - pad),
    east: r(Math.max(...list.map((s) => s.lng)) + pad),
  };
}

// Refresh whichever source is older than the TTL; keep the last good copy of any that fails.
async function refresh(list: Site[]): Promise<Store> {
  const s: Store = store ?? (await fromDisk()) ?? { errors: {} };
  const now = Date.now();
  const stale = (at?: number) => !at || now - at > TTL_MS;
  const cells = new Map<string, { lat: number; lng: number }>();
  for (const site of list) { const c = cellOf(site.lat, site.lng); cells.set(cellKey(c), c); }
  const wanted = [...cells.values()];
  const missing = (have?: Record<string, unknown>) => !have || wanted.some((c) => !have[cellKey(c)]);
  const jobs: Promise<void>[] = [];
  if (stale(s.forecast?.at) || missing(s.forecast?.cells)) {
    jobs.push(fetchForecast(wanted).then((rows) => { s.forecast = { at: Date.now(), cells: Object.fromEntries(rows.map((r) => [cellKey(r), r])) }; delete s.errors.forecast; }).catch((e) => { s.errors.forecast = `${e instanceof Error ? e.message : e} (${s.forecast ? "showing the saved copy" : "no saved copy"})`; }));
  }
  if (stale(s.river?.at) || missing(s.river?.cells)) {
    jobs.push(fetchRiver(wanted, new Date()).then((rows) => { s.river = { at: Date.now(), cells: Object.fromEntries(rows.map((r) => [cellKey(r), r])) }; delete s.errors.river; }).catch((e) => { s.errors.river = `${e instanceof Error ? e.message : e} (${s.river ? "showing the saved copy" : "no saved copy"})`; }));
  }
  if (stale(s.flood?.at)) {
    const bbox = bboxOf(list);
    jobs.push(
      fetchFloodRaster(bbox, todayIso())
        .catch(() => fetchFloodRaster(bbox, yesterdayIso()))
        .then((raster) => { s.flood = { at: Date.now(), raster }; delete s.errors.flood; })
        .catch((e) => { s.errors.flood = `${e instanceof Error ? e.message : e} (${s.flood ? "showing the saved copy" : "no saved copy"})`; }),
    );
  }
  if (jobs.length) { await Promise.all(jobs); toDisk(s); }
  store = s;
  return s;
}

function describe(s: Store): { sources: string[]; preliminary: string } {
  const sources: string[] = [];
  const f = Object.values(s.forecast?.cells ?? {})[0];
  if (f) sources.push(`Open-Meteo forecast (ECMWF IFS / GFS best match, ~11 km; 16 days ahead, 30 days back from the model analysis), run ${f.modelRun}, ${Object.keys(s.forecast!.cells).length} grid cells, fetched ${new Date(s.forecast!.at).toISOString()}`);
  const r = Object.values(s.river?.cells ?? {})[0];
  if (r) sources.push(`Copernicus GloFAS v4 river discharge (5 km) via the Open-Meteo flood API, forecast to ${r.dates.last}, baseline ${r.history.length} days of history from ${r.dates.first}, fetched ${new Date(s.river!.at).toISOString()}`);
  if (s.flood) sources.push(`NASA LANCE MODIS/VIIRS near-real-time 3-day flood composite (MODIS_Combined_Flood_3-Day via GIBS, 250 m read at ~550 m), composite date ${s.flood.raster.date}, fetched ${new Date(s.flood.at).toISOString()}`);
  const preliminary =
    "PRELIMINARY: rain beyond day 7 is model guidance and shifts with each run; Open-Meteo's past days are the model's own analysis, not rain gauges. GloFAS cells here are small tributaries, so the river signal is relative to last year's record, not an absolute flood stage. The NASA flood map shows open water over areas of 250 m or more where the sky was clear; it does not say whether a particular road, bridge or ford is passable. The dispatcher confirms with the district driver before a truck leaves.";
  return { sources, preliminary };
}

// The cached picture, refreshed when older than three hours. Concurrent callers share one fetch.
export async function getWeather(): Promise<Weather> {
  if (!inflight) {
    inflight = (async () => {
      const list = await sites();
      const s = await refresh(list);
      const { sources, preliminary } = describe(s);
      const at = Math.max(s.forecast?.at ?? 0, s.river?.at ?? 0, s.flood?.at ?? 0);
      return { store: s, sites: list, fetchedAt: at ? new Date(at).toISOString() : new Date().toISOString(), sources, preliminary, errors: { ...s.errors } };
    })().finally(() => { inflight = null; });
  }
  return inflight;
}

// Nearest cached cell to any point (exact cell first, else the closest within one cell), so a
// road sample a little outside the posts' grid still gets an answer.
export function nearestCell<T extends { lat: number; lng: number }>(cells: Record<string, T> | undefined, lat: number, lng: number): T | null {
  if (!cells) return null;
  const exact = cells[cellKey(cellOf(lat, lng))];
  if (exact) return exact;
  let best: T | null = null, bestD = Infinity;
  for (const c of Object.values(cells)) {
    const d = Math.hypot(c.lat - lat, (c.lng - lng) * Math.cos((lat * Math.PI) / 180));
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= CELL_DEG * 2.5 ? best : null;
}

export type PostOutlook = Site & RainSummary & CutOff & {
  floodRiskToday: Risk; floodRiskTodayReasons: string[];
  floodRisk14d: Risk; floodRisk14dReasons: string[];
  malariaOutlook6w: Risk; malariaReason: string;
  river: RiverRise | null;
  floodNow: FloodNear | null;
};

export function outlookFor(site: Site, w: Weather): PostOutlook | null {
  const f = nearestCell(w.store.forecast?.cells, site.lat, site.lng);
  if (!f) return null;
  const rain = summarizeRain(f);
  const rc = nearestCell(w.store.river?.cells, site.lat, site.lng);
  const river = rc ? riverRise(rc) : null;
  const flood = w.store.flood ? floodNear(w.store.flood.raster, site.lat, site.lng, POST_RADIUS_KM) : null;
  const today = floodRiskToday(rain, river, flood);
  const ahead = floodRisk14d(rain, river, flood);
  const mal = malariaOutlook(rain);
  return { ...site, ...rain, ...cutOff(f, rain, flood), floodRiskToday: today.risk, floodRiskTodayReasons: today.reasons, floodRisk14d: ahead.risk, floodRisk14dReasons: ahead.reasons, malariaOutlook6w: mal.outlook, malariaReason: mal.reason, river, floodNow: flood };
}

export type RoadSample = { lat: number; lng: number; risk: Risk; reasons: string[]; rain72hMm: number; rainWindowMm: number; wettestWindowMm: number; wettestWindowDate: string | null; floodPct: number | null; observedPct: number | null; cell: string | null };
export type RoadRisk = { risk: Risk; reasons: string[]; from: { lat: number; lng: number }; to: { lat: number; lng: number }; distanceKm: number; date: string; days: number; samples: RoadSample[]; sources: string[]; preliminary: string; fetchedAt: string };

// Straight-line samples between two points (3 for short legs, up to 5 for long ones), each read
// against its forecast cell and the flood map; the leg carries the worst sample.
export function roadRisk(from: { lat: number; lng: number }, to: { lat: number; lng: number }, w: Weather, opts: { date?: string; days?: number } = {}): RoadRisk {
  const km = haversineKm(from, to);
  const n = km < 40 ? 3 : km < 120 ? 4 : 5;
  const days = Math.min(16, Math.max(1, opts.days ?? 3));
  const anyCell = Object.values(w.store.forecast?.cells ?? {})[0];
  const today = anyCell?.future[0]?.date ?? todayIso();
  const date = opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : today;
  const startIdx = Math.max(0, Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400_000));
  const samples: RoadSample[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const lat = from.lat + (to.lat - from.lat) * t, lng = from.lng + (to.lng - from.lng) * t;
    const f = nearestCell(w.store.forecast?.cells, lat, lng);
    const rc = nearestCell(w.store.river?.cells, lat, lng);
    const flood = w.store.flood ? floodNear(w.store.flood.raster, lat, lng, ROAD_RADIUS_KM) : null;
    if (!f) {
      samples.push({ lat: r3(lat), lng: r3(lng), risk: "low", reasons: ["no forecast cell cached near this point"], rain72hMm: 0, rainWindowMm: 0, wettestWindowMm: 0, wettestWindowDate: null, floodPct: flood?.floodPct ?? null, observedPct: flood?.observedPct ?? null, cell: null });
      continue;
    }
    const s = sampleRisk(f, startIdx, days, rc ? riverRise(rc) : null, flood);
    samples.push({ lat: r3(lat), lng: r3(lng), ...s, floodPct: flood?.inside ? flood.floodPct : null, observedPct: flood?.inside ? flood.observedPct : null, cell: cellKey(f) });
  }
  const risk = worst(...samples.map((s) => s.risk));
  const worstSample = samples.find((s) => s.risk === risk) ?? samples[0];
  const reasons = worstSample ? worstSample.reasons.map((r) => `${r} (near ${worstSample.lat}, ${worstSample.lng})`) : ["no weather available"];
  if (startIdx + days > 16) reasons.push("window runs past the 16-day forecast; later days unknown");
  if (!w.store.forecast) reasons.push(w.errors.forecast ?? "forecast unavailable");
  return { risk, reasons, from, to, distanceKm: Math.round(km), date, days, samples, sources: w.sources, preliminary: w.preliminary, fetchedAt: w.fetchedAt };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
