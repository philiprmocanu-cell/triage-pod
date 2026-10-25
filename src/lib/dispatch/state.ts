// Gathers everything the dispatch planner needs from the live network: the SpacetimeDB tables
// (over the same HTTP SQL path src/app/api/satellite/route.ts uses), the weather outlook
// (GET /api/weather/outlook when the Weather agent's route exists; otherwise derived from
// GET /api/satellite, called in-process) and the carriers (the `carrier` table when the module
// publishes it; otherwise the fallback fleet in plan.ts).

import { GET as satelliteGET } from "@/app/api/satellite/route";
import { dueFor, nextDoses } from "@/lib/vaccines";
import { fallbackFleet, type Carrier, type PostOutlook, type PostSeason, type PostState } from "./plan";

const URL_BASE = process.env.SPACETIME_HTTP ?? "http://127.0.0.1:3000";
const DB = process.env.SPACETIME_DB ?? "podnet";

// A red visit counts as open for this long, or while its patient order is still moving.
const RED_OPEN_MS = 2 * 3600_000;

type Row = Record<string, unknown>;

// One SQL statement -> rows as objects with the column names the module uses (snake_case).
export async function sql(query: string): Promise<Row[]> {
  const res = await fetch(`${URL_BASE}/v1/database/${DB}/sql`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: query, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`SpacetimeDB sql ${res.status}: ${await res.text()}`);
  const [table] = (await res.json()) as { schema: { elements: { name: { some: string } }[] }; rows: unknown[][] }[];
  if (!table) return [];
  const col = table.schema.elements.map((e) => e.name.some);
  return table.rows.map((r) => Object.fromEntries(r.map((v, i) => [col[i], v])));
}

// Timestamps arrive as [micros] over SQL.
const ms = (v: unknown) => (Array.isArray(v) && typeof v[0] === "number" ? v[0] / 1000 : typeof v === "number" ? v / 1000 : 0);

// Reducer call over HTTP, arguments as a JSON array in the module's order.
export async function callReducer(reducer: string, args: unknown[]) {
  const res = await fetch(`${URL_BASE}/v1/database/${DB}/call/${reducer}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args), signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`SpacetimeDB ${reducer} ${res.status}: ${await res.text()}`);
}

export async function tableExists(name: string) {
  try {
    await sql(`SELECT * FROM ${name} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

// ---- Weather ----

type SatellitePost = { villageId: number; name: string; rain30Mm: number; wettestDayMm: number; meanTempC: number; lastYearRain30Mm: number | null; malariaRisk: "low" | "medium" | "high"; floodRisk: boolean };
// What GET /api/weather/outlook returns per post (src/lib/weather/model.ts): risk LEVELS for
// today and the fortnight, the day the roads may close (`cutOffDays`, 0 = today or already) and
// a sentence saying why (`cutOffRisk`), the forecast rain, and the six-week malaria outlook.
type Level = "low" | "medium" | "high";
type OutlookPost = {
  villageId?: number;
  name?: string;
  floodRiskToday?: Level | boolean;
  floodRisk14d?: Level | boolean;
  rainNext14Mm?: number;
  malariaOutlook6w?: Level;
  cutOffRisk?: string | number;
  cutOffDays?: number | null;
  cutOffDate?: string | null;
  floodNow?: { floodPct?: number };
};

const short = (name: string) => name.replace(/ \(.*\)$/, "").toLowerCase();
const level = (v: Level | boolean | undefined): Level => (v === true ? "high" : v === "medium" || v === "high" ? v : "low");

// Days until the roads close, from the cut-off probability: a certain closure that has already
// started is today; a likely one inside the fortnight lands in proportion to how likely it is.
function daysFromRisk(o: { cutOffRisk: number; floodRiskToday: boolean; floodRisk14d: boolean }): number | null {
  if (o.cutOffRisk < 0.4 && !o.floodRiskToday) return null;
  if (o.floodRiskToday) return o.cutOffRisk >= 0.8 ? 1 : 2;
  if (o.floodRisk14d) return Math.max(2, Math.round(14 * (1 - o.cutOffRisk)));
  return o.cutOffRisk >= 0.4 ? 10 : null;
}

// A probability for the cut-off, from the weather route's levels and closure day, so the planner
// can rank posts against each other. 0.9 when the roads may already be cut; otherwise the
// fortnight's flood level when a closing day is named, a small number when none is.
function riskFromLevels(cutOffDays: number | null, today: Level, fortnight: Level, floodPct: number) {
  if (cutOffDays === 0 || floodPct >= 20) return 0.9;
  if (cutOffDays !== null) return fortnight === "high" ? 0.8 : fortnight === "medium" ? 0.6 : 0.45;
  if (today === "high") return 0.5;
  if (today === "medium" || fortnight === "high") return 0.3;
  if (fortnight === "medium") return 0.2;
  return 0.05;
}

// The outlook per post, the Weather agent's route first.
export async function loadOutlook(origin: string | null): Promise<{ byKey: Map<string, PostOutlook>; source: string }> {
  const byKey = new Map<string, PostOutlook>();
  if (origin) {
    try {
      const res = await fetch(`${origin}/api/weather/outlook`, { signal: AbortSignal.timeout(25000), cache: "no-store" });
      if (res.ok) {
        const json = (await res.json()) as { posts?: OutlookPost[]; sources?: unknown; source?: string } | OutlookPost[];
        const posts = Array.isArray(json) ? json : json.posts ?? [];
        for (const p of posts) {
          const today = level(p.floodRiskToday), fortnight = level(p.floodRisk14d);
          const cutOffDays = typeof p.cutOffDays === "number" ? p.cutOffDays : null;
          const floodPct = Number(p.floodNow?.floodPct ?? 0);
          const cutOffRisk = typeof p.cutOffRisk === "number" && Number.isFinite(p.cutOffRisk) ? Math.max(0, Math.min(1, p.cutOffRisk)) : riskFromLevels(cutOffDays, today, fortnight, floodPct);
          const o: PostOutlook = {
            malariaOutlook6w: level(p.malariaOutlook6w),
            floodRiskToday: today !== "low",
            floodRisk14d: fortnight !== "low",
            floodTodayLevel: today,
            flood14dLevel: fortnight,
            rainNext14Mm: Number(p.rainNext14Mm ?? 0) || 0,
            cutOffRisk,
            daysUntilCutOff: cutOffDays ?? daysFromRisk({ cutOffRisk, floodRiskToday: today !== "low", floodRisk14d: fortnight !== "low" }),
            cutOffNow: cutOffDays === 0 || today === "high" || floodPct >= 20,
            cutOffReason: typeof p.cutOffRisk === "string" ? p.cutOffRisk : undefined,
            cutOffDate: p.cutOffDate ?? null,
            source: "outlook",
          };
          if (p.villageId) byKey.set(`id:${p.villageId}`, o);
          if (p.name) byKey.set(`name:${short(p.name)}`, o);
        }
        if (byKey.size) return { byKey, source: "/api/weather/outlook (Open-Meteo forecast, GloFAS river, satellite flood water; malaria outlook six weeks out)" };
      }
    } catch {
      // fall through to the satellite
    }
  }
  // Fallback: the last 30 days of satellite weather, read forward. Rain and warm nights now mean
  // malaria in two to six weeks; a very wet day means the road is at risk; the next fortnight is
  // assumed to look like the last one (persistence), unless NASA's preliminary numbers are out of
  // all proportion to last year's finished record, in which case last year's rain is used.
  try {
    const json = (await (await satelliteGET()).json()) as { posts?: SatellitePost[]; source?: string };
    for (const p of json.posts ?? []) {
      const implausible = p.lastYearRain30Mm !== null && p.rain30Mm > 5 * p.lastYearRain30Mm + 50;
      const rain30 = implausible ? p.lastYearRain30Mm ?? 0 : p.rain30Mm;
      const rainNext14Mm = Math.round((rain30 * 14) / 30);
      const floodRiskToday = p.floodRisk;
      const floodRisk14d = floodRiskToday || (!implausible && p.wettestDayMm >= 25) || rainNext14Mm >= 100;
      const cutOffRisk = floodRiskToday ? (p.wettestDayMm >= 80 ? 0.85 : 0.7) : floodRisk14d ? 0.45 : rainNext14Mm >= 60 ? 0.25 : 0.05;
      const o: PostOutlook = {
        malariaOutlook6w: p.malariaRisk,
        floodRiskToday,
        floodRisk14d,
        floodTodayLevel: floodRiskToday ? (p.wettestDayMm >= 80 ? "high" : "medium") : "low",
        flood14dLevel: floodRisk14d ? (floodRiskToday ? "high" : "medium") : "low",
        rainNext14Mm,
        cutOffRisk,
        daysUntilCutOff: daysFromRisk({ cutOffRisk, floodRiskToday, floodRisk14d }),
        cutOffNow: floodRiskToday && cutOffRisk >= 0.8,
        cutOffReason: floodRiskToday ? `a ${p.wettestDayMm} mm day in the last month; the next fortnight assumed like the last` : undefined,
        cutOffDate: null,
        source: "satellite",
      };
      byKey.set(`id:${p.villageId}`, o);
      byKey.set(`name:${short(p.name)}`, o);
    }
    return { byKey, source: `derived from /api/satellite (last 30 days read forward): ${json.source ?? ""}` };
  } catch {
    return { byKey, source: "no weather available" };
  }
}

// ---- Seasons ----

// The ten-year calendar per post (GET /api/weather/seasons): the dates the planner needs for the
// seasonal pre-positioning rule and the season strip. Missing or down: no seasonal shipments.
export async function loadSeasons(origin: string | null): Promise<{ byId: Map<number, PostSeason>; byName: Map<string, PostSeason>; source: string }> {
  const byId = new Map<number, PostSeason>(), byName = new Map<string, PostSeason>();
  if (!origin) return { byId, byName, source: "no seasonal calendar (no origin)" };
  try {
    const res = await fetch(`${origin}/api/weather/seasons`, { signal: AbortSignal.timeout(90_000), cache: "no-store" });
    if (!res.ok) return { byId, byName, source: `seasonal calendar unavailable (${res.status})` };
    const json = (await res.json()) as { posts?: (PostSeason & { villageId?: number; name?: string })[]; range?: { start: string; end: string }; errors?: string | null; note?: string };
    for (const p of json.posts ?? []) {
      const s: PostSeason = { wetSeasonStart: p.wetSeasonStart, wetSeasonEnd: p.wetSeasonEnd, closureStart: p.closureStart, closureEnd: p.closureEnd, closureWeeks: (p.closureWeeks ?? []).map((w) => ({ from: w.from, to: w.to, frequency: w.frequency })), cutOffDaysByMonth: p.cutOffDaysByMonth ?? [], cutOffDaysInSeason: p.cutOffDaysInSeason ?? 0, malariaPeak: p.malariaPeak, confidence: p.confidence };
      if (p.villageId) byId.set(p.villageId, s);
      if (p.name) byName.set(short(p.name), s);
    }
    return { byId, byName, source: `/api/weather/seasons (ERA5 daily rain ${json.range?.start ?? ""} → ${json.range?.end ?? ""} from the Open-Meteo archive; ${byId.size} posts${json.errors ? `; ${json.errors}` : ""})` };
  } catch (e) {
    return { byId, byName, source: `seasonal calendar unavailable (${e instanceof Error ? e.message : e})` };
  }
}

const NO_OUTLOOK: PostOutlook = { malariaOutlook6w: "low", floodRiskToday: false, floodRisk14d: false, floodTodayLevel: "low", flood14dLevel: "low", rainNext14Mm: 0, cutOffRisk: 0, daysUntilCutOff: null, cutOffNow: false, cutOffDate: null, source: "none" };

// ---- Carriers ----

export async function loadCarriers(posts: Pick<PostState, "id" | "name" | "hub">[]): Promise<{ carriers: Carrier[]; source: "table" | "fallback" }> {
  try {
    const rows = await sql("SELECT * FROM carrier");
    const carriers: Carrier[] = rows.map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      kind: String(r.kind),
      operator: String(r.operator ?? ""),
      baseVillageId: Number(r.base_village_id ?? r.baseVillageId ?? 1),
      capacityKg: Number(r.capacity_kg ?? r.capacityKg ?? 0),
      speedKmh: Number(r.speed_kmh ?? r.speedKmh ?? 30),
      costPerKm: Number(r.cost_per_km ?? r.costPerKm ?? 5),
      status: String(r.status ?? "idle"),
    }));
    if (carriers.length) return { carriers, source: "table" };
  } catch {
    // the module has not published `carrier` yet
  }
  return { carriers: fallbackFleet(posts), source: "fallback" };
}

// ---- The whole picture ----

export type NetworkState = { posts: PostState[]; carriers: Carrier[]; carrierSource: "table" | "fallback"; weatherSource: string; seasonSource: string; now: Date };

export async function loadState(origin: string | null): Promise<NetworkState> {
  const now = new Date();
  const [villages, stock, visits, orders, patients, outlook, seasons] = await Promise.all([
    sql("SELECT * FROM village"),
    sql("SELECT * FROM stock"),
    sql("SELECT * FROM visit"),
    sql("SELECT * FROM delivery_order"),
    sql("SELECT * FROM patient"),
    loadOutlook(origin),
    loadSeasons(origin),
  ]);
  if (!villages.length) throw new Error("SpacetimeDB has no villages (is `spacetime start` running and the module published?)");

  // Patient orders still moving, per visit, so a red visit stays open until its order lands.
  const movingByVisit = new Set(orders.filter((o) => o.kind === "patient" && o.status !== "delivered").map((o) => Number(o.visit_id)));

  const posts: PostState[] = villages.map((v) => {
    const id = Number(v.id), name = String(v.name);
    const mine = (rows: Row[], col: string) => rows.filter((r) => Number(r[col]) === id);
    const stockMap: Record<string, number> = {};
    for (const s of mine(stock, "village_id")) stockMap[String(s.item)] = Number(s.qty);
    const incoming: Record<string, number> = {};
    for (const o of orders) if (o.kind === "restock" && Number(o.to_village_id) === id && o.status !== "delivered") incoming[String(o.item)] = (incoming[String(o.item)] ?? 0) + Number(o.qty);
    const redVisitsOpen = mine(visits, "village_id").filter((x) => x.urgency === "red" && (now.getTime() - ms(x.created_at) <= RED_OPEN_MS || movingByVisit.has(Number(x.id)))).length;
    const needMap = new Map<string, number>();
    for (const o of orders) if (o.kind === "patient" && Number(o.to_village_id) === id && o.status !== "delivered") needMap.set(String(o.item), (needMap.get(String(o.item)) ?? 0) + Number(o.qty));
    const vaccinesDue: Record<string, number> = {};
    for (const p of mine(patients, "village_id")) {
      for (const d of nextDoses(dueFor({ ageMonths: Number(p.age_months), sex: String(p.sex), pregnant: !!p.pregnant, vaccinesGiven: String(p.vaccines_given ?? "") }))) vaccinesDue[d.item] = (vaccinesDue[d.item] ?? 0) + 1;
    }
    return {
      id,
      name,
      lat: Number(v.lat),
      lng: Number(v.lng),
      population: Number(v.population),
      hub: !!v.hub,
      stock: stockMap,
      incoming,
      redVisitsOpen,
      openNeeds: [...needMap].map(([item, qty]) => ({ item, qty })),
      vaccinesDue,
      outlook: { ...(outlook.byKey.get(`id:${id}`) ?? outlook.byKey.get(`name:${short(name)}`) ?? NO_OUTLOOK), season: seasons.byId.get(id) ?? seasons.byName.get(short(name)) ?? null },
    };
  });
  const { carriers, source: carrierSource } = await loadCarriers(posts);
  return { posts, carriers, carrierSource, weatherSource: outlook.source, seasonSource: seasons.source, now };
}
