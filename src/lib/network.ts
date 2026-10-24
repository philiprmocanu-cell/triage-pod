// The supply network behind the pods: health posts, their stock, what the AI triage says
// patients will need, and a plan that moves supplies BEFORE a post runs out.
//
// Demand comes from triage: every visit lists the supplies the patient will likely need, with a
// probability. Summed over the last 48 hours (real pod visits + simulated background visits),
// that is each post's forecast. Shortage = stock - forecast - safety buffer - already on the way.
// The plan fills the worst shortages first: by drone from the hub when the item is light enough,
// by road otherwise; flooded roads force drones, and oxygen (too heavy to fly) is flagged so the
// patient is sent to a post that has it.
//
// Demo data: approximate locations in Eastern Province, Zambia. State lives in server memory.

import { runAgents } from "./agents";
import { readRegistry, VisitRecord } from "./registry";

export type Post = { id: string; name: string; lat: number; lng: number; hub?: boolean; population: number; oxygen: boolean };

export const POSTS: Post[] = [
  { id: "chipata", name: "Chipata (hub + drone base)", lat: -13.633, lng: 32.65, hub: true, population: 127000, oxygen: true },
  { id: "katete", name: "Katete", lat: -14.05, lng: 32.05, population: 26000, oxygen: false },
  { id: "petauke", name: "Petauke", lat: -14.25, lng: 31.32, population: 31000, oxygen: true },
  { id: "sinda", name: "Sinda", lat: -14.217, lng: 31.767, population: 12000, oxygen: false },
  { id: "nyimba", name: "Nyimba", lat: -14.55, lng: 30.817, population: 9000, oxygen: false },
  { id: "lundazi", name: "Lundazi", lat: -12.283, lng: 33.167, population: 17000, oxygen: true },
  { id: "chadiza", name: "Chadiza", lat: -14.067, lng: 32.433, population: 8000, oxygen: false },
  { id: "mfuwe", name: "Mfuwe (Mambwe)", lat: -13.083, lng: 31.783, population: 10000, oxygen: false },
  { id: "vubwi", name: "Vubwi", lat: -13.983, lng: 32.883, population: 6000, oxygen: false },
  { id: "chama", name: "Chama", lat: -11.217, lng: 33.167, population: 15000, oxygen: false },
  { id: "lumezi", name: "Lumezi", lat: -12.8, lng: 32.75, population: 7000, oxygen: false },
  { id: "kasenengwa", name: "Kasenengwa", lat: -13.88, lng: 32.17, population: 6500, oxygen: false },
];

export type Sku = { id: string; label: string; kg: number; drone: boolean; critical: number; match: RegExp };

export const SKUS: Sku[] = [
  { id: "amox", label: "Amoxicillin", kg: 0.06, drone: true, critical: 3, match: /amoxicillin|antibiotic/i },
  { id: "rdt", label: "Malaria rapid tests", kg: 0.02, drone: true, critical: 3, match: /rapid test/i },
  { id: "act", label: "Antimalarials (ACT)", kg: 0.04, drone: true, critical: 3, match: /artemisinin|antimalarial/i },
  { id: "artesunate", label: "Rectal artesunate", kg: 0.05, drone: true, critical: 4, match: /artesunate/i },
  { id: "ors", label: "Oral rehydration salts", kg: 0.03, drone: true, critical: 3, match: /rehydration/i },
  { id: "zinc", label: "Zinc", kg: 0.01, drone: true, critical: 2, match: /zinc/i },
  { id: "paracetamol", label: "Paracetamol", kg: 0.02, drone: true, critical: 1, match: /paracetamol/i },
  { id: "aspirin", label: "Aspirin", kg: 0.01, drone: true, critical: 3, match: /aspirin/i },
  { id: "glucose", label: "Glucose test strips", kg: 0.02, drone: true, critical: 2, match: /glucose/i },
  { id: "salbutamol", label: "Salbutamol inhalers", kg: 0.1, drone: true, critical: 3, match: /salbutamol/i },
  { id: "rutf", label: "Therapeutic food (RUTF)", kg: 0.1, drone: true, critical: 3, match: /rutf|therapeutic food/i },
  { id: "blood", label: "Blood units", kg: 0.5, drone: true, critical: 5, match: /blood \(drone\)|blood unit/i },
  { id: "dressing", label: "Wound dressing kits", kg: 0.1, drone: true, critical: 1, match: /dressing|bandage/i },
  { id: "oxygen", label: "Oxygen cylinders", kg: 15, drone: false, critical: 5, match: /oxygen/i },
];

const DRONE_PAYLOAD_KG = 1.75;
const DRONE_RANGE_KM = 80;
const DRONE_KMH = 110;
const ROAD_KMH = 35;
const HORIZON_H = 48;
const SIM_SPEED = 60; // the demo runs 60x faster than real time

export type Visit = {
  id: string;
  post: string;
  t: number;
  needs: Record<string, number>;
  kind?: string; // what brought them in, e.g. "malaria", "respiratory"
  fever?: boolean;
  red?: boolean;
  source: "pod" | "sim";
  summary?: string; // short description for agents (real pod visits)
};
let visitSeq = 0;
export type Flight = {
  id: string;
  from: string;
  to: string;
  mode: "drone" | "road";
  items: { sku: string; qty: number }[];
  kg: number;
  km: number;
  minutes: number; // real-world travel time
  status: "proposed" | "flying" | "delivered";
  departAt?: number;
  arriveAt?: number;
  reason: string;
};

type State = {
  stock: Record<string, Record<string, number>>;
  simVisits: Visit[];
  flights: Flight[];
  flooded: Set<string>;
  outbreak: { post: string; kind: "malaria" | "diarrhea" | "respiratory"; since: number } | null;
  lastTick: number;
  seq: number;
};

// Seeded so every demo starts the same way.
function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

function initialState(): State {
  const r = rng(42);
  const stock: State["stock"] = {};
  for (const p of POSTS) {
    stock[p.id] = {};
    for (const s of SKUS) {
      if (s.id === "oxygen") stock[p.id][s.id] = p.oxygen ? (p.hub ? 40 : 6) : 0;
      else if (s.id === "blood") stock[p.id][s.id] = p.hub ? 30 : 0;
      else stock[p.id][s.id] = p.hub ? 400 : Math.round(4 + r() * 22);
    }
  }
  const now = Date.now();
  const simVisits: Visit[] = [];
  // Two days of background visits so forecasts start realistic.
  for (const p of POSTS) {
    const perDay = Math.max(4, Math.round(p.population / 9000));
    for (let i = 0; i < perDay * 2; i++) simVisits.push(simVisit(p.id, now - r() * HORIZON_H * 3600_000 / SIM_SPEED, r));
  }
  return { stock, simVisits, flights: [], flooded: new Set(), outbreak: null, lastTick: now, seq: 0 };
}

// A typical patient mix for the region: respiratory, fever, diarrhea, and some of everything else.
function simVisit(post: string, t: number, r: () => number, kind?: "malaria" | "diarrhea" | "respiratory"): Visit {
  const k = kind ?? (["respiratory", "respiratory", "malaria", "diarrhea", "other", "other"] as const)[Math.floor(r() * 6)];
  const needs: Record<string, number> = { paracetamol: 0.5 + r() * 0.4 };
  if (k === "respiratory") Object.assign(needs, { amox: 0.6 + r() * 0.35, oxygen: r() < 0.08 ? 0.6 : 0 });
  if (k === "malaria") Object.assign(needs, { rdt: 0.9, act: 0.5 + r() * 0.4, artesunate: r() < 0.1 ? 0.7 : 0 });
  if (k === "diarrhea") Object.assign(needs, { ors: 0.85, zinc: 0.8 });
  if (k === "other") {
    const pick = SKUS[Math.floor(r() * SKUS.length)];
    if (pick.id !== "oxygen" && pick.id !== "blood") needs[pick.id] = 0.4 + r() * 0.5;
  }
  return { id: `sim-${++visitSeq}`, post, t, needs, kind: k, fever: k === "malaria" || (k === "respiratory" && r() < 0.5), red: r() < 0.06, source: "sim" };
}

const g = globalThis as unknown as { __network?: State; __networkPosts?: string };
// State survives code reloads; if the list of posts changed (new country), start over.
const state = () => {
  const key = POSTS.map((p) => p.id).join(",");
  if (!g.__network || g.__networkPosts !== key) {
    g.__network = initialState();
    g.__networkPosts = key;
    const a = globalThis as unknown as { __agents?: unknown };
    a.__agents = undefined;
  }
  return g.__network;
};

// Pod visits come from the registry; their community decides which post they belong to.
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
export function postFor(community: string | null | undefined): string {
  if (!community) return "katete";
  const c = norm(community);
  return POSTS.find((p) => norm(p.name).split(/[ (]/).some((w) => w.length > 3 && c.includes(w)))?.id ?? "katete";
}
function podVisit(r: VisitRecord): Visit {
  const needs: Record<string, number> = {};
  for (const res of r.resources) {
    const sku = SKUS.find((s) => s.match.test(res.item));
    if (sku) needs[sku.id] = Math.max(needs[sku.id] ?? 0, res.probability);
  }
  const fever = /malaria|fever|pneumonia/i.test(r.causes.map((c) => c.name).join(" "));
  return {
    id: r.id,
    post: postFor(r.community),
    t: new Date(r.createdAt).getTime(),
    needs,
    kind: r.causes[0]?.name,
    fever,
    red: r.urgency === "red",
    source: "pod",
    summary: `${r.patient ?? r.ageGroup}, ${r.urgency.toUpperCase()}: ${r.reason}`,
  };
}

function km(a: Post, b: Post) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const post = (id: string) => POSTS.find((p) => p.id === id)!;

// Advance the simulation: new background visits, outbreak visits, arrivals.
function tick(s: State) {
  const now = Date.now();
  const r = rng(Math.floor(now / 1000));
  const elapsedSimH = ((now - s.lastTick) / 3600_000) * SIM_SPEED;
  if (elapsedSimH > 0.25) {
    for (const p of POSTS) {
      const perHour = Math.max(4, p.population / 9000) / 24;
      let n = perHour * elapsedSimH;
      while (n > 0) {
        if (r() < Math.min(1, n)) dispense(s, simVisit(p.id, now, r), r);
        n -= 1;
      }
    }
    if (s.outbreak) {
      const extra = Math.round(elapsedSimH * 3);
      for (let i = 0; i < extra; i++) dispense(s, simVisit(s.outbreak.post, now, r, s.outbreak.kind), r);
    }
    s.lastTick = now;
  }
  const cutoff = now - (HORIZON_H * 3600_000) / SIM_SPEED;
  s.simVisits = s.simVisits.filter((v) => v.t >= cutoff);
  for (const f of s.flights) {
    if (f.status === "flying" && f.arriveAt && now >= f.arriveAt) {
      f.status = "delivered";
      for (const it of f.items) {
        s.stock[f.from][it.sku] -= it.qty;
        s.stock[f.to][it.sku] = (s.stock[f.to][it.sku] ?? 0) + it.qty;
      }
    }
  }
}

// A new patient: record the visit and hand out what they needed, using up the post's stock.
function dispense(s: State, v: Visit, r: () => number) {
  s.simVisits.push(v);
  for (const [sku, prob] of Object.entries(v.needs)) {
    if (r() < prob && s.stock[v.post][sku] > 0) s.stock[v.post][sku] -= 1;
  }
}

export async function snapshot() {
  const s = state();
  tick(s);
  const now = Date.now();
  const cutoff = now - (HORIZON_H * 3600_000) / SIM_SPEED;
  const podVisits = (await readRegistry()).map(podVisit).filter((v) => v.t >= cutoff);
  const visits = [...s.simVisits, ...podVisits];

  // Forecast = expected units needed in the next 48 h at each post. Outbreaks grow it.
  const forecast: Record<string, Record<string, number>> = {};
  for (const p of POSTS) forecast[p.id] = Object.fromEntries(SKUS.map((k) => [k.id, 0]));
  for (const v of visits) for (const [sku, prob] of Object.entries(v.needs)) forecast[v.post][sku] += prob;
  if (s.outbreak) for (const sku of Object.keys(forecast[s.outbreak.post])) forecast[s.outbreak.post][sku] *= 1.6;

  // Outbreak alarm: fever visits in the last 6 sim-hours vs the post's usual rate.
  const recent = now - (6 * 3600_000) / SIM_SPEED;
  const alerts: { post: string; text: string; level: "red" | "amber" }[] = [];
  for (const p of POSTS) {
    const fevers = visits.filter((v) => v.post === p.id && v.fever);
    const rate = fevers.filter((v) => v.t >= recent).length / 6;
    const usual = fevers.length / HORIZON_H || 0.01;
    if (rate > Math.max(1, usual * 2.5)) alerts.push({ post: p.id, level: "red", text: `${p.name}: fever cases ${Math.round(rate / usual)}× normal — possible outbreak` });
  }
  for (const f of s.flooded) alerts.push({ post: f, level: "amber", text: `${post(f).name}: road flooded (satellite) — drones only` });

  // Shortages, after counting what is already on the way.
  const incoming = (to: string, sku: string) =>
    s.flights.filter((f) => f.to === to && f.status !== "delivered").reduce((n, f) => n + (f.items.find((i) => i.sku === sku)?.qty ?? 0), 0);
  type Short = { post: string; sku: string; qty: number; need: number; have: number; hoursLeft: number; score: number };
  const shortages: Short[] = [];
  for (const p of POSTS) {
    if (p.hub) continue;
    for (const k of SKUS) {
      const need = forecast[p.id][k.id];
      if (need < 0.5) continue;
      const have = s.stock[p.id][k.id] + incoming(p.id, k.id);
      const buffer = Math.max(2, need * 0.25);
      const gap = have - need - buffer;
      if (gap < 0) {
        const hoursLeft = (s.stock[p.id][k.id] / need) * HORIZON_H;
        shortages.push({ post: p.id, sku: k.id, qty: Math.ceil(-gap), need, have: s.stock[p.id][k.id], hoursLeft, score: k.critical * (1 + -gap / Math.max(1, need)) });
      }
    }
  }
  shortages.sort((a, b) => b.score - a.score);

  // Plan: group shortages per destination into drone flights (≤ payload) or road trips.
  const hub = POSTS.find((p) => p.hub)!;
  const hubFree = (sku: string) => s.stock[hub.id][sku] - (sku === "oxygen" ? 10 : 50) - s.flights.filter((f) => f.from === hub.id && f.status !== "delivered").reduce((n, f) => n + (f.items.find((i) => i.sku === sku)?.qty ?? 0), 0);
  const proposals: Flight[] = [];
  const cantFly: { post: string; sku: string; text: string }[] = [];
  const byDest = new Map<string, Short[]>();
  for (const sh of shortages) byDest.set(sh.post, [...(byDest.get(sh.post) ?? []), sh]);
  for (const [dest, list] of byDest) {
    const to = post(dest);
    const dist = km(hub, to);
    const flooded = s.flooded.has(dest);
    let drone: Flight | null = null;
    let road: Flight | null = null;
    for (const sh of list) {
      const k = SKUS.find((x) => x.id === sh.sku)!;
      const qty = Math.min(sh.qty, Math.max(0, Math.floor(hubFree(k.id))));
      if (qty <= 0) continue;
      const why = `${k.label} runs out in ~${Math.max(1, Math.round(sh.hoursLeft))} h (need ${sh.need.toFixed(0)}, have ${sh.have})`;
      if (k.drone && dist <= DRONE_RANGE_KM) {
        let left = qty;
        while (left > 0) {
          if (!drone || drone.kg + k.kg > DRONE_PAYLOAD_KG) {
            drone = newFlight(s, hub.id, dest, "drone", dist, why);
            proposals.push(drone);
          }
          const fit = Math.max(1, Math.min(left, Math.floor((DRONE_PAYLOAD_KG - drone.kg) / k.kg)));
          drone.items.push({ sku: k.id, qty: fit });
          drone.kg += fit * k.kg;
          left -= fit;
        }
      } else if (!flooded) {
        if (!road) {
          road = newFlight(s, hub.id, dest, "road", dist, why);
          proposals.push(road);
        }
        road.items.push({ sku: k.id, qty });
        road.kg += qty * k.kg;
      } else {
        const alt = POSTS.filter((p) => p.oxygen && p.id !== dest && !s.flooded.has(p.id)).sort((a, b) => km(to, a) - km(to, b))[0];
        cantFly.push({ post: dest, sku: k.id, text: `${to.name}: ${k.label} can't fly and the road is flooded — send patients who need it to ${alt?.name ?? "the hub"}` });
      }
    }
  }
  // Keep proposals stable between refreshes: replace only the proposed ones.
  s.flights = [...s.flights.filter((f) => f.status !== "proposed"), ...proposals];

  const status: Record<string, "ok" | "low" | "out"> = {};
  for (const p of POSTS) {
    const worst = shortages.filter((x) => x.post === p.id);
    status[p.id] = worst.some((x) => x.have === 0 && x.need >= 1) ? "out" : worst.length ? "low" : "ok";
  }

  // Let the agents react to what changed: new patients, alerts, shortages, flights.
  try {
    runAgents({ now, visits, alerts, flights: s.flights, shortages: shortages.map((x) => ({ post: x.post, label: SKUS.find((k) => k.id === x.sku)!.label, hoursLeft: x.hoursLeft })) });
  } catch (err) {
    console.error("agents failed (network keeps running)", err); // never let the agents take down the dashboard or saving a visit
  }

  const last24 = now - (24 * 3600_000) / SIM_SPEED;
  return {
    now,
    simSpeed: SIM_SPEED,
    posts: POSTS.map((p) => ({
      ...p,
      status: status[p.id],
      flooded: s.flooded.has(p.id),
      outbreak: s.outbreak?.post === p.id ? s.outbreak.kind : null,
      visits24h: visits.filter((v) => v.post === p.id && v.t >= last24).length,
      podVisits: podVisits.filter((v) => v.post === p.id).length,
    })),
    skus: SKUS.map((k) => ({ id: k.id, label: k.label, kg: k.kg, drone: k.drone, critical: k.critical })),
    stock: s.stock,
    forecast,
    shortages: shortages.slice(0, 25).map((x) => ({ ...x, postName: post(x.post).name, label: SKUS.find((k) => k.id === x.sku)!.label })),
    flights: s.flights,
    cantFly,
    alerts,
    outbreak: s.outbreak,
    kpis: {
      visits24h: visits.filter((v) => v.t >= last24).length,
      podVisits: podVisits.length,
      redCases: visits.filter((v) => v.red && v.t >= last24).length,
      shortages: shortages.length,
      proposed: s.flights.filter((f) => f.status === "proposed").length,
      flying: s.flights.filter((f) => f.status === "flying").length,
      delivered: s.flights.filter((f) => f.status === "delivered").length,
    },
  };
}

function newFlight(s: State, from: string, to: string, mode: "drone" | "road", dist: number, reason: string): Flight {
  const roadKm = dist * 1.6; // mountain roads wind
  const kmTravel = mode === "drone" ? dist : roadKm;
  return {
    id: `${mode}-${to}-${++s.seq}`,
    from,
    to,
    mode,
    items: [],
    kg: 0,
    km: Math.round(kmTravel),
    minutes: Math.round((kmTravel / (mode === "drone" ? DRONE_KMH : ROAD_KMH)) * 60),
    status: "proposed",
    reason,
  };
}

export function act(action: { type: string; id?: string; post?: string; kind?: "malaria" | "diarrhea" | "respiratory" }) {
  const s = state();
  const now = Date.now();
  const launch = (f: Flight) => {
    f.status = "flying";
    f.departAt = now;
    f.arriveAt = now + Math.max(4000, (f.minutes * 60_000) / SIM_SPEED); // demo speed, at least 4 s on screen
  };
  if (action.type === "approve" && action.id) {
    const f = s.flights.find((x) => x.id === action.id && x.status === "proposed");
    if (f) launch(f);
  }
  if (action.type === "approve_all") s.flights.filter((f) => f.status === "proposed").forEach(launch);
  if (action.type === "outbreak" && action.post) {
    s.outbreak = { post: action.post, kind: action.kind ?? "malaria", since: now };
    // A burst of sick patients arriving at once, so the demo shows the system react within seconds.
    const r = rng(now);
    for (let i = 0; i < 18; i++) dispense(s, simVisit(action.post, now - i * 500, r, s.outbreak.kind), r);
  }
  if (action.type === "end_outbreak") s.outbreak = null;
  if (action.type === "flood" && action.post) {
    if (s.flooded.has(action.post)) s.flooded.delete(action.post);
    else s.flooded.add(action.post);
  }
  if (action.type === "reset") g.__network = initialState();
}
