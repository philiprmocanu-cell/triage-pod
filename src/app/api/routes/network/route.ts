import { NextResponse } from "next/server";
import { haversineKm, roadPath, roadTour, routerSource, type LatLng, type RoadPath } from "@/lib/routes/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Tone = "red" | "yellow" | "green";
type Hamlet = { id: string; name: string; lat: number; lng: number; tone?: Tone; post?: boolean };
type CarrierIn = { id: number; name: string; kind: string; capacityKg: number; lat: number; lng: number; tone?: Tone };
type Branch = { id: string; name: string; lat: number; lng: number; from: LatLng; km: number };
type PrevRun = {
  id: string;
  carrierId: number;
  truck: string;
  color: string;
  km: number;
  points: LatLng[];
  stops: Hamlet[];
  branches?: Branch[];
  loadKg: number;
  freeKg: number;
  capacityKg: number;
  tone?: Tone;
  why?: string;
};
type Body = {
  hub?: { name: string; lat: number; lng: number };
  hamlets?: Hamlet[];
  carriers?: CarrierIn[];
  flood?: boolean;
  seed?: number;
  previous?: PrevRun[];
  liveFlood?: { dry: boolean; note: string; blocked?: string[] };
};

type Cluster = { pts: Hamlet[]; lat: number; lng: number };

const KG = 40;
const VISIT_KM = 2.4;
const SHADES: Record<Tone, string[]> = {
  red: ["rgba(255,55,55,0.9)", "rgba(255,90,55,0.9)", "rgba(239,68,68,0.9)", "rgba(248,113,113,0.9)", "rgba(220,38,38,0.9)", "rgba(251,113,133,0.9)"],
  yellow: ["rgba(250,204,21,0.92)", "rgba(251,191,36,0.92)", "rgba(245,158,11,0.92)", "rgba(253,224,71,0.92)", "rgba(234,179,8,0.92)"],
  green: ["rgba(52,211,153,0.9)", "rgba(74,222,128,0.9)", "rgba(16,185,129,0.9)", "rgba(110,231,183,0.9)"],
};
const shadeAt: Record<Tone, number> = { red: 0, yellow: 0, green: 0 };

function districtTone(pts: Hamlet[]): Tone {
  let red = 0;
  let yellow = 0;
  let green = 0;
  for (const p of pts) {
    if (p.tone === "yellow") yellow += 1;
    else if (p.tone === "green") green += 1;
    else if (p.tone === "red") red += 1;
  }
  if (red === 0 && yellow === 0 && green === 0) return "red";
  if (red >= yellow && red >= green) return "red";
  if (yellow >= green) return "yellow";
  return "green";
}

function nextShade(tone: Tone) {
  const list = SHADES[tone];
  const i = shadeAt[tone]++;
  return list[i % list.length];
}

function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  return haversineKm([a.lat, a.lng], [b.lat, b.lng]);
}

function centroid(pts: Hamlet[]): Cluster {
  let lat = 0;
  let lng = 0;
  for (const p of pts) {
    lat += p.lat;
    lng += p.lng;
  }
  return { pts, lat: lat / pts.length, lng: lng / pts.length };
}

function diameter(pts: Hamlet[]) {
  const c = centroid(pts);
  let max = 0;
  for (const p of pts) max = Math.max(max, km(c, p));
  return max * 2;
}

// Every chosen hamlet goes to the nearest of k seeds, spread across the province.
function clusterAll(pts: Hamlet[], k: number): Cluster[] {
  const n = Math.max(1, Math.min(k, pts.length));
  const seeds: { lat: number; lng: number }[] = [pts[0]];
  while (seeds.length < n) {
    let best = pts[0];
    let score = -1;
    const step = Math.max(1, Math.floor(pts.length / 900));
    for (let i = 0; i < pts.length; i += step) {
      let gap = Infinity;
      for (const s of seeds) gap = Math.min(gap, km(s, pts[i]));
      if (gap > score) {
        score = gap;
        best = pts[i];
      }
    }
    seeds.push(best);
  }
  let centers = seeds.map((s) => ({ lat: s.lat, lng: s.lng }));
  let groups: Hamlet[][] = centers.map(() => []);
  for (let iter = 0; iter < 3; iter++) {
    groups = centers.map(() => []);
    for (const p of pts) {
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < centers.length; i++) {
        const d = km(centers[i], p);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      groups[bi].push(p);
    }
    centers = groups.map((g, i) => (g.length ? { lat: centroid(g).lat, lng: centroid(g).lng } : centers[i]));
  }
  return groups.filter((g) => g.length >= 2).map((g) => centroid(g));
}

// Two patches share a truck only when they are neighbors and the joined patch is still a local
// round, not a corridor across the province. The spare truck stays parked.
function mergeNeighbors(clusters: Cluster[]) {
  let left = clusters;
  for (;;) {
    let bi = -1;
    let bj = -1;
    let best = 24;
    for (let i = 0; i < left.length; i++) {
      for (let j = i + 1; j < left.length; j++) {
        const d = km(left[i], left[j]);
        if (d >= best) continue;
        if (diameter(left[i].pts.concat(left[j].pts)) > 42) continue;
        best = d;
        bi = i;
        bj = j;
      }
    }
    if (bi < 0) break;
    const union = left[bi].pts.concat(left[bj].pts);
    left = left.filter((_, i) => i !== bi && i !== bj).concat([centroid(union)]);
  }
  return left;
}

// A chain of hamlets where each hop is a short one, so the road bends through a village
// and the next village rather than crossing the province between two towns.
function threadStops(pts: Hamlet[], maxStops: number, minKm: number, hopKm: number) {
  if (!pts.length) return [];
  const c = centroid(pts);
  let start = pts[0];
  let sd = Infinity;
  for (const p of pts) {
    const d = km(c, p);
    if (d < sd) {
      sd = d;
      start = p;
    }
  }
  const out = [start];
  let at = start;
  while (out.length < maxStops) {
    let best: Hamlet | null = null;
    let bd = hopKm;
    for (const p of pts) {
      if (out.some((s) => s.id === p.id || km(s, p) < minKm)) continue;
      const d = km(at, p);
      if (d < minKm || d >= bd) continue;
      bd = d;
      best = p;
    }
    if (!best) break;
    out.push(best);
    at = best;
  }
  return out;
}

function coverStops(pts: Hamlet[], maxStops: number) {
  const spaced = threadStops(pts, maxStops, 4, 16);
  if (spaced.length >= 8) return spaced;
  const closer = threadStops(pts, maxStops, 2.2, 20);
  return closer.length >= spaced.length ? closer : spaced;
}

const HOP_KM = 40;
const ON_ROAD_KM = 0.7;
const BRANCH_KM = HOP_KM;
const BRANCH_MIN = ON_ROAD_KM;
const BRANCH_CAP = 8000;

// Short hops off the driven road. A hamlet farther than this is not this truck's, and it is not drawn.
function attachBranches(pts: Hamlet[], stops: Hamlet[], line: LatLng[]): Branch[] {
  const stopIds = new Set(stops.map((s) => s.id));
  const stride = Math.max(1, Math.floor(line.length / 180));
  const samples: LatLng[] = [];
  for (let i = 0; i < line.length; i += stride) samples.push(line[i]);
  if (line.length) samples.push(line[line.length - 1]);
  const hits: { h: Hamlet; at: LatLng; d: number }[] = [];
  for (const h of pts) {
    if (stopIds.has(h.id)) continue;
    let best = BRANCH_KM;
    let at = samples[0];
    for (const p of samples) {
      const d = haversineKm(p, [h.lat, h.lng]);
      if (d < best) {
        best = d;
        at = p;
      }
    }
    if (at && best < BRANCH_KM && best >= BRANCH_MIN) hits.push({ h, at, d: best });
  }
  hits.sort((a, b) => a.d - b.d);
  return hits.slice(0, BRANCH_CAP).map((hit) => ({
    id: hit.h.id,
    name: hit.h.name,
    lat: hit.h.lat,
    lng: hit.h.lng,
    from: hit.at,
    km: Math.round(hit.d * 10) / 10,
  }));
}

function snapBranch(line: LatLng[], branch: Branch): Branch {
  let best = branch.from;
  let bd = Infinity;
  const stride = Math.max(1, Math.floor(line.length / 180));
  for (let i = 0; i < line.length; i += stride) {
    const d = haversineKm(line[i], [branch.lat, branch.lng]);
    if (d < bd) {
      bd = d;
      best = line[i];
    }
  }
  return { ...branch, from: best, km: Math.round(bd * 10) / 10 };
}

function evenly(stops: Hamlet[], n: number) {
  if (stops.length <= n) return stops;
  const out: Hamlet[] = [];
  const jump = (stops.length - 1) / (n - 1);
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const p = stops[Math.round(i * jump)];
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

function roadWord() {
  return routerSource() === "google" ? "the Google road" : "the OpenStreetMap road";
}

function glowOf(color: string) {
  return color.replace(/[\d.]+\)$/, "0.22)");
}

function nearestIndex(pts: LatLng[], p: LatLng) {
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = haversineKm(pts[i], p);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  return bi;
}

function spliceLeg(full: LatLng[], a: LatLng, b: LatLng, replacement: LatLng[]) {
  let i = nearestIndex(full, a);
  let j = nearestIndex(full, b);
  if (i > j) [i, j] = [j, i];
  const ordered = haversineKm(full[i], replacement[0]) <= haversineKm(full[i], replacement[replacement.length - 1]) ? replacement : [...replacement].reverse();
  return [...full.slice(0, i), ...ordered, ...full.slice(j + 1)];
}

// Leave the district store and walk outward. The old chain hugged the nearest hamlets, so the
// road coiled in a few kilometres while the rest of the district stayed blank.
function outwardStops(base: { lat: number; lng: number }, pts: Hamlet[], maxStops: number, minHop: number, maxHop: number) {
  const pool = pts.filter((p) => km(base, p) >= minHop * 0.6);
  const source = pool.length >= 6 ? pool : pts;
  let start = source[0];
  let sd = Infinity;
  for (const p of source) {
    const d = km(base, p);
    if (d < sd) {
      sd = d;
      start = p;
    }
  }
  const out = [start];
  let at = start;
  while (out.length < maxStops) {
    let best: Hamlet | null = null;
    let score = -1;
    for (const p of source) {
      if (out.some((s) => s.id === p.id)) continue;
      const hop = km(at, p);
      if (hop < minHop || hop > maxHop) continue;
      const away = km(base, p);
      const next = away - hop * 0.2;
      if (next > score) {
        score = next;
        best = p;
      }
    }
    if (!best) break;
    out.push(best);
    at = best;
  }
  return out;
}

async function districtDrive(base: CarrierIn, pts: Hamlet[]) {
  const lists = [
    outwardStops(base, pts, 8, 8, 36),
    outwardStops(base, pts, 7, 6, 55),
    (() => {
      const sorted = [...pts].sort((a, b) => km(base, a) - km(base, b));
      const spread: Hamlet[] = [];
      for (const p of sorted) {
        if (spread.length >= 7) break;
        if (spread.some((s) => km(s, p) < 8)) continue;
        spread.push(p);
      }
      return spread;
    })(),
  ];
  let shortest: Awaited<ReturnType<typeof drive>> = null;
  for (const stops of lists) {
    if (stops.length < 6) continue;
    const driven = await drive(base, stops);
    if (!driven || driven.tour.km < 20) continue;
    if (driven.tour.km <= 220) return driven;
    if (!shortest || driven.tour.km < shortest.tour.km) shortest = driven;
  }
  if (shortest && shortest.tour.km <= 260) return shortest;
  return null;
}

async function drive(base: { lat: number; lng: number }, stops: Hamlet[]) {
  const attempt = async (list: Hamlet[]) => {
    if (list.length < 6) return null;
    // The depot is on the line only when the truck is already in this patch. A far base would
    // draw a corridor across the province before the first hamlet.
    const fromBase = km(base, list[0]) <= 55;
    const coords: LatLng[] = fromBase ? [[base.lat, base.lng]] : [];
    for (const s of list) coords.push([s.lat, s.lng]);
    const tour = await roadTour(coords);
    if (tour && tour.source !== "straight" && tour.points.length >= 4 && tour.km <= 900) return { tour, stops: list };
    return null;
  };
  const full = await attempt(stops);
  if (full) return full;
  if (stops.length > 12) {
    const mid = await attempt(evenly(stops, 12));
    if (mid) return mid;
  }
  if (stops.length > 8) return attempt(evenly(stops, 8));
  return null;
}

function lineSamples(line: LatLng[]) {
  const stride = Math.max(1, Math.floor(line.length / 140));
  const pts: LatLng[] = [];
  for (let i = 0; i < line.length; i += stride) pts.push(line[i]);
  if (line.length) pts.push(line[line.length - 1]);
  let minLa = 90;
  let maxLa = -90;
  let minLn = 180;
  let maxLn = -180;
  for (const p of pts) {
    minLa = Math.min(minLa, p[0]);
    maxLa = Math.max(maxLa, p[0]);
    minLn = Math.min(minLn, p[1]);
    maxLn = Math.max(maxLn, p[1]);
  }
  const pad = HOP_KM / 111;
  return { pts, minLa: minLa - pad, maxLa: maxLa + pad, minLn: minLn - pad, maxLn: maxLn + pad };
}

function spreadStops(anchor: { lat: number; lng: number }, pts: Hamlet[], n: number) {
  if (!pts.length) return [];
  let start = pts[0];
  let sd = Infinity;
  for (const p of pts) {
    const d = km(anchor, p);
    if (d < sd) {
      sd = d;
      start = p;
    }
  }
  const out = [start];
  while (out.length < n && out.length < pts.length) {
    let best: Hamlet | null = null;
    let score = -1;
    for (const p of pts) {
      if (out.some((s) => s.id === p.id)) continue;
      let near = Infinity;
      for (const s of out) near = Math.min(near, km(s, p));
      const next = near + km(anchor, p) * 0.15;
      if (next > score) {
        score = next;
        best = p;
      }
    }
    if (!best || score < 3) break;
    out.push(best);
  }
  return out;
}

function loopStops(anchor: { lat: number; lng: number }, pts: Hamlet[], n: number) {
  const spread = spreadStops(anchor, pts, n);
  if (spread.length < 3) return spread;
  const c = centroid(spread);
  const ordered = [...spread].sort((a, b) => Math.atan2(a.lat - c.lat, a.lng - c.lng) - Math.atan2(b.lat - c.lat, b.lng - c.lng));
  let start = 0;
  let sd = Infinity;
  ordered.forEach((p, i) => {
    const d = km(anchor, p);
    if (d < sd) {
      sd = d;
      start = i;
    }
  });
  return [...ordered.slice(start), ...ordered.slice(0, start)];
}

function weavePost(stops: Hamlet[], post: Hamlet): Hamlet[] {
  if (stops.some((s) => s.id === post.id)) return stops;
  let at = 0;
  let best = Infinity;
  stops.forEach((s, i) => {
    const d = km(s, post);
    if (d < best) {
      best = d;
      at = i;
    }
  });
  const out = stops.slice();
  out.splice(at + 1, 0, post);
  return out;
}

async function tourThrough(anchor: { lat: number; lng: number } | null, stops: Hamlet[]) {
  const coords: LatLng[] = [];
  if (anchor) coords.push([anchor.lat, anchor.lng]);
  for (const s of stops) {
    const last = coords[coords.length - 1];
    const here: LatLng = [s.lat, s.lng];
    if (last && haversineKm(last, here) < 0.8) continue;
    coords.push(here);
  }
  if (coords.length < 2) return null;
  const tour = await roadTour(coords);
  if (tour && tour.source !== "straight" && tour.points.length >= 4 && tour.km <= 640) return { tour, stops };
  return null;
}

async function driveRound(anchor: { lat: number; lng: number } | null, pts: Hamlet[]) {
  const focus = anchor ?? centroid(pts);
  // A district round can be long because the truck refuels. Keep the stops inside the patch
  // so the road does not wander off across the country. A shorter loop is used when the wide one will not.
  let road: { tour: RoadPath; stops: Hamlet[] } | null = null;
  for (const pass of [
    { n: 6, max: 110 },
    { n: 5, max: 75 },
    { n: 4, max: 45 },
    { n: 3, max: 28 },
  ]) {
    let pool = pts.filter((p) => km(focus, p) <= pass.max);
    if (pool.length < 6) pool = [...pts].sort((a, b) => km(focus, a) - km(focus, b)).slice(0, 8);
    const stops = loopStops(focus, pool, pass.n);
    if (stops.length < 2) continue;
    road = await tourThrough(anchor, stops);
    if (road) break;
  }
  if (!road) return null;
  // About two short health posts per truck, the ones already in this patch, so the road
  // actually stops there. A post that would push the round past the ceiling stays off.
  const posts = pts
    .filter((p) => p.post && km(focus, p) <= 90)
    .sort((a, b) => km(focus, a) - km(focus, b));
  let added = 0;
  for (const post of posts) {
    if (added >= 2) break;
    if (road.stops.some((s) => s.id === post.id)) {
      added += 1;
      continue;
    }
    const tried = await tourThrough(anchor, weavePost(road.stops, post));
    if (!tried) continue;
    road = tried;
    added += 1;
  }
  return road;
}

function overlapFrac(line: LatLng[], other: LatLng[]) {
  const a = lineSamples(line).pts;
  const b = lineSamples(other).pts;
  if (!a.length || !b.length) return 0;
  let close = 0;
  for (const p of a) {
    for (const q of b) {
      if (haversineKm(p, q) < 1.5) {
        close += 1;
        break;
      }
    }
  }
  return close / a.length;
}

async function pool<T, R>(items: T[], width: number, fn: (item: T, index: number) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;
  const hub = body.hub;
  const carriers = (body.carriers ?? []).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng) && c.capacityKg > 0 && c.kind !== "drone" && c.kind !== "boat" && c.kind !== "bicycle" && c.kind !== "motorbike");
  if (!hub || !carriers.length) return NextResponse.json({ error: "no fleet" }, { status: 400 });
  shadeAt.red = 0;
  shadeAt.yellow = 0;
  shadeAt.green = 0;

  if (body.flood && body.previous?.length) {
    const flooded = await floodRuns(body.previous, carriers, body.liveFlood);
    return NextResponse.json({
      router: routerSource(),
      fleet: carriers.length,
      rolled: flooded.runs.length,
      called: body.hamlets?.length ?? 0,
      held: flooded.held,
      compare: flooded.held,
      unchanged: flooded.unchanged,
      runs: flooded.runs,
    });
  }

  const hamlets = (body.hamlets ?? []).filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lng) && h.id);
  if (hamlets.length < 8) return NextResponse.json({ error: "no hamlets" }, { status: 400 });
  const pickups = carriers.filter((c) => c.kind === "pickup");
  const hubs = carriers.filter((c) => c.kind === "truck");
  const homes = pickups.length ? pickups : carriers;
  const groups = new Map<number, { carrier: CarrierIn; pts: Hamlet[] }>();
  for (const home of homes) groups.set(home.id, { carrier: home, pts: [] });
  const loose: Hamlet[] = [];
  for (const h of hamlets) {
    let best = homes[0];
    let bd = Infinity;
    for (const home of homes) {
      const d = km(home, h);
      if (d < bd) {
        bd = d;
        best = home;
      }
    }
    if (best && bd < 160) groups.get(best.id)!.pts.push(h);
    else loose.push(h);
  }

  type Job = { carrier: CarrierIn; pts: Hamlet[]; anchor: { lat: number; lng: number } | null; tone: Tone; homeId: number };
  const jobs: Job[] = [];
  const ranked = [...groups.values()].filter((g) => g.pts.length >= 8).sort((a, b) => b.pts.length - a.pts.length);
  const splitHubs = hubs.slice();
  for (const group of ranked) {
    const tone: Tone = group.carrier.tone === "yellow" ? "yellow" : "red";
    let pickPts = group.pts;
    const hubTruck = splitHubs[0];
    if (hubTruck && group.pts.length >= 40) {
      const c = centroid(group.pts);
      let latSpan = 0;
      let lngSpan = 0;
      for (const p of group.pts) {
        latSpan = Math.max(latSpan, Math.abs(p.lat - c.lat));
        lngSpan = Math.max(lngSpan, Math.abs(p.lng - c.lng));
      }
      const byLng = lngSpan >= latSpan;
      const west: Hamlet[] = [];
      const east: Hamlet[] = [];
      for (const p of group.pts) ((byLng ? p.lng < c.lng : p.lat < c.lat) ? west : east).push(p);
      const [near, far] = west.length >= east.length ? [west, east] : [east, west];
      if (near.length >= 12 && far.length >= 12) {
        pickPts = near;
        splitHubs.shift();
        jobs.push({ carrier: hubTruck, pts: far, anchor: null, tone, homeId: group.carrier.id });
      }
    }
    jobs.push({ carrier: group.carrier, pts: pickPts, anchor: group.carrier, tone, homeId: group.carrier.id });
  }
  if (loose.length >= 12) {
    for (const hubTruck of splitHubs) {
      if (loose.length < 12) break;
      const seed = loose[0];
      const mine = loose.filter((h) => km(seed, h) < 70);
      if (mine.length < 12) break;
      const ids = new Set(mine.map((h) => h.id));
      for (let i = loose.length - 1; i >= 0; i--) if (ids.has(loose[i].id)) loose.splice(i, 1);
      jobs.push({ carrier: hubTruck, pts: mine, anchor: null, tone: "red", homeId: -hubTruck.id });
    }
  }

  const driven = await pool(jobs, 4, async (job) => {
    const road = await driveRound(job.anchor, job.pts);
    return road ? { ...job, ...road } : null;
  });
  const ready = driven.filter((d): d is NonNullable<(typeof driven)[number]> => !!d);
  const pickupRoads = new Map<number, LatLng[]>();
  for (const d of ready) if (d.carrier.kind === "pickup") pickupRoads.set(d.homeId, d.tour.points);
  const kept = ready.filter((d) => {
    if (d.carrier.kind === "pickup") return true;
    const other = pickupRoads.get(d.homeId);
    if (!other) return true;
    return overlapFrac(d.tour.points, other) < 0.35;
  });

  const runs = kept.map((d) => {
    const color = nextShade(d.tone);
    const home = carriers.find((c) => c.id === d.homeId);
    const district = (home?.name ?? d.carrier.name).replace(/^.*pickup\s+/i, "").replace(/ \(.*\)$/, "");
    const place = d.carrier.kind === "pickup" ? district : /cold/i.test(d.carrier.name) ? `${district} cold` : `${district} hub`;
    return {
      id: `run-${d.carrier.id}`,
      carrierId: d.carrier.id,
      truck: d.carrier.name,
      place,
      color,
      glow: glowOf(color),
      km: Math.round(d.tour.km * 10) / 10,
      points: d.tour.points,
      wet: [] as LatLng[],
      reroute: false,
      tone: d.tone,
      why: "",
      loadKg: d.carrier.capacityKg,
      freeKg: 0,
      capacityKg: d.carrier.capacityKg,
      visits: 0,
      label: null as { lat: number; lng: number; text: string } | null,
      stops: d.stops.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, post: s.post || undefined, tone: s.post ? s.tone : undefined })),
      branches: [] as Branch[],
      onRoad: [] as { id: string; name: string; lat: number; lng: number }[],
    };
  });

  const boxes = runs.map((run) => lineSamples(run.points));
  const stopIds = new Set(runs.flatMap((run) => run.stops.map((s) => s.id)));
  let reached = stopIds.size;
  for (const h of hamlets) {
    if (stopIds.has(h.id)) continue;
    let best = HOP_KM;
    let bi = -1;
    let at: LatLng | null = null;
    for (let r = 0; r < boxes.length; r++) {
      const box = boxes[r];
      if (h.lat < box.minLa || h.lat > box.maxLa || h.lng < box.minLn || h.lng > box.maxLn) continue;
      for (const p of box.pts) {
        const d = haversineKm(p, [h.lat, h.lng]);
        if (d < best) {
          best = d;
          bi = r;
          at = p;
        }
      }
    }
    if (bi < 0 || !at) continue;
    reached += 1;
    if (best < ON_ROAD_KM) runs[bi].onRoad.push({ id: h.id, name: h.name, lat: at[0], lng: at[1] });
    else {
      runs[bi].branches.push({
        id: h.id,
        name: h.name,
        lat: h.lat,
        lng: h.lng,
        from: at,
        km: Math.round(best * 10) / 10,
      });
    }
  }
  for (const run of runs) {
    const named = run.stops.filter((s) => !/^-?\d/.test(s.name)).slice(0, 3).map((s) => s.name);
    const sample = (named.length ? named : run.stops.slice(0, 2).map((s) => s.name)).join(" → ");
    const kind = run.tone === "yellow" ? "Running low" : "Emergency";
    const postStops = run.stops.filter((s) => s.post);
    const postLine = postStops.length
      ? ` Short posts on this road: ${postStops.map((s) => `${s.name} (${s.tone === "yellow" ? "short, life-saving stock still in" : "life-saving stock at zero"})`).join("; ")}.`
      : "";
    run.visits = run.stops.length + run.branches.length + run.onRoad.length;
    run.why = `${kind}. ${run.truck} drives ${sample ? `through ${sample}` : "its round"} on ${roadWord()}, ${run.km} km. ${run.branches.length} dashed hops reach the other lit dots within 40 km. It can refuel at a district town or at the Chipata store, so the round is not cut short to save kilometres.${postLine}`;
  }

  if (!runs.length) return NextResponse.json({ error: "no road" }, { status: 502 });
  const calledDots = hamlets.filter((h) => !h.post).length;
  const postOnRoad = runs.flatMap((run) => run.stops.filter((s) => s.post));
  const dropped = Math.max(0, hamlets.length - reached);
  const kms = runs.map((r) => r.km);
  const yellowTrucks = runs.filter((r) => r.tone === "yellow").map((r) => r.truck);
  const shared = ready.length - kept.length;
  const noRoad = jobs.length - ready.length;
  const held = `${calledDots.toLocaleString()} dots were called. ${runs.length} trucks rolled, ${Math.min(...kms).toFixed(0)}–${Math.max(...kms).toFixed(0)} km. ${reached.toLocaleString()} of them sit on a road or on a dashed hop within 40 km.${dropped > 0 ? ` ${dropped.toLocaleString()} were farther than 40 km from every road, so they stay unlit.` : " Every called dot is on a line."} ${yellowTrucks.length ? `${yellowTrucks.join(" and ")} ${yellowTrucks.length === 1 ? "is" : "are"} running low, so ${yellowTrucks.length === 1 ? "that road is" : "those roads are"} yellow.` : ""} The other rounds are emergency red.${postOnRoad.length ? ` ${postOnRoad.length} short health posts are stops on a road: ${postOnRoad.map((s) => s.name).join(", ")}. A red post is out of a life-saving item. A yellow post is short, with those four still in stock.` : ""} No rural post is fully stocked, so there is no green routine round. Chipata stays the store.${shared > 0 ? ` ${shared} truck${shared === 1 ? "" : "s"} stayed put so two trucks would not draw the same road.` : ""}${noRoad > 0 ? ` ${noRoad} truck${noRoad === 1 ? "" : "s"} had no OpenStreetMap round that stayed in its own district.` : ""}${shared + noRoad === 0 ? " District pickups and Chipata trucks are on different roads." : ""} Motorbikes, bicycles, and boats stay off this wave.`;
  return NextResponse.json({
    router: routerSource(),
    fleet: carriers.length,
    rolled: runs.length,
    called: hamlets.length,
    reached,
    held,
    compare: held,
    runs,
  });
}

function savings(
  hamlets: Hamlet[],
  runs: { carrierId: number; km: number; stops: Hamlet[]; branches: Branch[] }[],
  carriers: CarrierIn[],
) {
  const seen = new Set<string>();
  let spoke = 0;
  let planKm = 0;
  let branched = 0;
  let connected = 0;
  for (const run of runs) {
    planKm += run.km;
    const base = carriers.find((c) => c.id === run.carrierId);
    const mine: { id: string; lat: number; lng: number; hop: number }[] = [
      ...run.stops.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, hop: 0 })),
      ...run.branches.map((b) => ({ id: b.id, lat: b.lat, lng: b.lng, hop: b.km })),
    ];
    for (const h of mine) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      connected += 1;
      if (h.hop) branched += 1;
      if (base) spoke += 2 * km(base, h);
      planKm += h.hop;
    }
  }
  const waiting = hamlets.filter((h) => !seen.has(h.id)).length;
  const saved = Math.max(0, spoke - planKm);
  const pct = spoke > 0 ? Math.round((100 * saved) / spoke) : 0;
  return `Sending each hamlet its own trip from the nearest store, straight there and straight back, would be ${Math.round(spoke)} km. Sharing the real roads is ${Math.round(planKm)} km, ${pct}% less driving. The ${branched} thin lines are hamlets a town-to-town map would miss. ${waiting.toLocaleString()} other called hamlets sit too far from this wave's roads, so they are not drawn.`;
}

function assignVisits(hamlets: Hamlet[], runs: { points: LatLng[]; stops: { id: string }[] }[]) {
  const owned = runs.map(() => new Set<string>());
  const samples = runs.map((run) => {
    const line = run.points;
    const stride = Math.max(1, Math.floor(line.length / 260));
    const pts: LatLng[] = [];
    for (let i = 0; i < line.length; i += stride) pts.push(line[i]);
    if (line.length) pts.push(line[line.length - 1]);
    let minLa = 90;
    let maxLa = -90;
    let minLn = 180;
    let maxLn = -180;
    for (const p of pts) {
      minLa = Math.min(minLa, p[0]);
      maxLa = Math.max(maxLa, p[0]);
      minLn = Math.min(minLn, p[1]);
      maxLn = Math.max(maxLn, p[1]);
    }
    return { pts, minLa: minLa - 0.03, maxLa: maxLa + 0.03, minLn: minLn - 0.03, maxLn: maxLn + 0.03 };
  });
  for (const h of hamlets) {
    let best = VISIT_KM;
    let bi = -1;
    const here: LatLng = [h.lat, h.lng];
    for (let r = 0; r < samples.length; r++) {
      const box = samples[r];
      if (h.lat < box.minLa || h.lat > box.maxLa || h.lng < box.minLn || h.lng > box.maxLn) continue;
      for (const p of box.pts) {
        const d = haversineKm(p, here);
        if (d < best) {
          best = d;
          bi = r;
        }
      }
    }
    if (bi >= 0) owned[bi].add(h.id);
  }
  for (let r = 0; r < runs.length; r++) {
    for (const s of runs[r].stops) {
      for (const set of owned) set.delete(s.id);
      owned[r].add(s.id);
    }
  }
  return owned;
}

function takeCarrier(carriers: CarrierIn[], cluster: Cluster, used: Set<number>) {
  const free = carriers.filter((c) => !used.has(c.id));
  const pickups = free.filter((c) => c.kind === "pickup").sort((a, b) => km(a, cluster) - km(b, cluster));
  const near = pickups.find((c) => km(c, cluster) < 120);
  if (near) return near;
  const trucks = free.filter((c) => c.kind === "truck").sort((a, b) => km(a, cluster) - km(b, cluster));
  if (trucks[0]) return trucks[0];
  if (pickups[0] && km(pickups[0], cluster) < 200) return pickups[0];
  return null;
}

function placeKey(name: string) {
  return name.replace(/\s*\(.*\)$/, "").trim().toLowerCase();
}

async function floodRuns(previous: PrevRun[], carriers: CarrierIn[], live?: { dry: boolean; note: string; blocked?: string[] }) {
  void carriers;
  const blocked = new Set((live?.blocked ?? []).map(placeKey).filter(Boolean));
  const outlook = live?.note ? `${live.note} ` : "";
  // A dry outlook, or no drawn road sitting on a flooded post, is not a reason to move anyone.
  if (!live || live.dry || blocked.size === 0) {
    return { unchanged: true, held: `${outlook}Nothing needs to be redrawn.`.trim(), runs: previous };
  }
  const runs = previous.map((r) => ({
    ...r,
    branches: (r.branches ?? []).map((b) => ({ ...b })),
    wet: [] as LatLng[],
    reroute: false,
    label: null as { lat: number; lng: number; text: string } | null,
  }));
  const moved: string[] = [];
  for (const run of runs) {
    const hitAt = run.stops.findIndex((s) => blocked.has(placeKey(s.name)));
    if (hitAt < 0) continue;
    const legs = [hitAt, hitAt + 1].filter((i) => i >= 1 && i < run.stops.length);
    for (const i of legs) {
      const a = run.stops[i - 1];
      const b = run.stops[i];
      const road = await roadPath([a.lat, a.lng], [b.lat, b.lng], { alternatives: true });
      const alt = road.alternatives.find((x) => x.source !== "straight" && x.points.length > 3 && Math.abs(x.km - road.main.km) > 1);
      if (road.main.source === "straight" || road.main.points.length < 4 || !alt) continue;
      run.wet = road.main.points;
      run.points = spliceLeg(run.points, [a.lat, a.lng], [b.lat, b.lng], alt.points);
      run.km = Math.round((run.km - road.main.km + alt.km) * 10) / 10;
      run.reroute = true;
      const mid = road.main.points[Math.floor(road.main.points.length / 2)];
      run.label = { lat: mid[0], lng: mid[1], text: `Flood · ${run.truck} left this road` };
      run.why = `${outlook}Between ${a.name} and ${b.name} the road is blocked. The thin blue line is that road. ${run.truck} takes the other OpenStreetMap road, ${run.km} km.`;
      run.branches = (run.branches ?? []).map((bch) => snapBranch(run.points, bch)).filter((bch) => bch.km <= HOP_KM && bch.km >= 0.15);
      moved.push(run.truck);
      break;
    }
  }
  if (!moved.length) return { unchanged: true, held: `${outlook}Nothing needs to be redrawn.`.trim(), runs: previous };
  return {
    unchanged: false,
    held: `${outlook}${moved.join(", ")} left the blocked road. The other trucks stay on the roads already drawn.`,
    runs,
  };
}
