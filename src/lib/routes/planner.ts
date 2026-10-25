import { logAgent, planRoute, sqlRows } from "@/lib/spacetime";
import { floodRisk, type FloodCheck, type FloodRisk } from "./flood";
import { haversineKm, minutesFor, roadPath, thin, type LatLng, type RoadPath } from "./router";
import { cachedSurface, describeSurface, sumSurfaces, surfaceSoon, type RoadSurface } from "./surface";

// Plans how one delivery order actually travels: which of Zambia's real carriers takes it, on
// which road, how far and how long, and what the flood check said. Writes the plan to the
// `route_plan` table through planRoute and one line to the agent log through logAgent.
//
// Carrier choice, in plain words:
//   - heavy items (oxygen cylinders, IV fluids) go by truck or pickup only;
//   - anything light goes with the quickest idle carrier that can carry the weight, counting the
//     drive from its base to the pickup point; cost per km breaks ties;
//   - drones are a proposed partner (no fleet in Zambia today), so they are only picked when the
//     road is flooded and nothing on the ground can go;
//   - an order within one village is a walk: the village's bicycle or motorbike, or the nearest.
// Flooded leg (risk high): first try the road's alternative (OSRM / Google alternatives); if the
// alternative's halves also come back high, switch to a carrier that does not need the road:
// motorbike (tracks), then boat (Luangwa posts), then drone (proposed). Either way the plan is
// marked `rerouted` with the reason.
//
// The road surface (surface.ts, from OpenStreetMap) joins the flood check: a dirt or track road
// under the same rain scores one level worse. A road not yet measured is measured in the
// background and counted at the next re-check (recheckAll, POST /api/routes/recheck).
//
// Multi-stop runs (planRun): the dispatch planner batches several posts into one truck or pickup
// run; the stops are ordered nearest-neighbour then 2-opt from the base, the whole tour is one
// road, and every order in the run gets the same route_plan with "run A stop 2 of 4" in its
// reason so the Routes page draws the run once with numbered stops.

type Village = { id: number; name: string; lat: number; lng: number; population: number; hub: boolean };
type Carrier = { id: number; name: string; kind: string; operator: string; base_village_id: number; capacity_kg: number; speed_kmh: number; cost_per_km: number; status: string };
type Order = { id: number; kind: string; patient_name: string; to_village_id: number; from_village_id: number; item: string; qty: number; mode: string; status: string };
type Plan = { id: number; order_id: number; carrier_id: number; waypoints: string; km: number; minutes: number; flood_risk: string; status: string; reason: string };

const HEAVY = new Set(["Oxygen cylinder", "IV fluids"]); // keep identical to the module
// Rough kg per unit, so a carrier's capacity means something.
const WEIGHT_KG: Record<string, number> = {
  "Oxygen cylinder": 15, "IV fluids": 1.2, "Blood (O negative)": 0.6, "Therapeutic food (RUTF)": 0.1, "Splint": 0.5, "Wound dressing kit": 0.4, "Salbutamol inhaler": 0.05,
};
const STOP_MINUTES = 20; // unloading at each stop of a run
const RANK: Record<FloodRisk, number> = { low: 0, medium: 1, high: 2 };
const short = (name: string) => name.replace(/ \(.*\)$/, "");

export function weightKg(item: string, qty: number) {
  return Math.round((WEIGHT_KG[item] ?? 0.3) * qty * 100) / 100;
}

export type PlanResult = {
  orderId: number;
  carrier: { id: number; name: string; kind: string; operator: string };
  km: number;
  minutes: number;
  floodRisk: FloodRisk;
  status: "planned" | "rerouted";
  reason: string;
  source: RoadPath["source"];
  flood: FloodCheck;
  weightKg: number;
  surface: RoadSurface | null;
  blocked?: { from: string; to: string; risk: FloodRisk; reason: string } | null; // the road_block row on the direct road, if any
};

// `waypoints: false` leaves the road geometry out of the plans (several MB once hundreds of
// routes are live); the planners only need each plan's carrier, the page and the watcher need the roads.
export async function loadWorld(opts: { waypoints?: boolean } = {}) {
  const [villages, carriers, orders, plans] = await Promise.all([
    sqlRows<Village>("SELECT * FROM village"),
    sqlRows<Carrier>("SELECT * FROM carrier"),
    sqlRows<Order>("SELECT id, kind, patient_name, to_village_id, from_village_id, item, qty, mode, status FROM delivery_order"),
    opts.waypoints === false
      ? sqlRows<Omit<Plan, "waypoints">>("SELECT id, order_id, carrier_id, km, minutes, flood_risk, status, reason FROM route_plan").then((rows) => rows.map((p) => ({ ...p, waypoints: "" }) as Plan))
      : sqlRows<Plan>("SELECT id, order_id, carrier_id, waypoints, km, minutes, flood_risk, status, reason FROM route_plan"),
  ]);
  return { villages, carriers, orders: orders.map((o) => ({ ...o, id: Number(o.id) })), plans: plans.map((p) => ({ ...p, id: Number(p.id), order_id: Number(p.order_id) })) };
}

const at = (v: Village): LatLng => [v.lat, v.lng];

// Quickest idle carrier of the allowed kinds that can take the weight, base-to-pickup drive included.
function pickCarrier(carriers: Carrier[], villages: Map<number, Village>, from: Village, to: Village, kg: number, kinds: string[], legKm: number, own = 0) {
  const scored = carriers
    .filter((c) => kinds.includes(c.kind) && c.status !== "down" && c.capacity_kg >= kg)
    .map((c) => {
      const base = villages.get(c.base_village_id);
      const deadheadKm = base ? haversineKm(at(base), at(from)) * (c.kind === "drone" ? 1 : 1.5) : 999;
      const minutes = minutesFor(deadheadKm + legKm, c.speed_kmh) + (c.status === "out" && c.id !== own ? 60 : 0); // out: it comes back first (unless it is already this order's)
      const cost = (deadheadKm + legKm) * c.cost_per_km;
      return { c, deadheadKm: Math.round(deadheadKm), minutes, cost };
    })
    .sort((a, b) => a.minutes - b.minutes || a.cost - b.cost);
  return scored[0] ?? null;
}

// A boat serves the valley posts around its landing, not only the post it is moored at.
const BOAT_REACH_KM = 20;
function boatNear(c: Carrier, villages: Map<number, Village>, from: Village, to: Village) {
  const base = villages.get(c.base_village_id);
  return !!base && (haversineKm(at(base), at(from)) <= BOAT_REACH_KM || haversineKm(at(base), at(to)) <= BOAT_REACH_KM);
}

// The surface of a road pair if it has been measured; otherwise start measuring for next time.
async function surfaceFor(a: LatLng, b: LatLng) {
  const s = await cachedSurface(a, b);
  if (!s) surfaceSoon(a, b);
  return s;
}

export type PlanOptions = { quiet?: boolean; agent?: string; carrierId?: number };

export async function planOrder(orderId: number, origin: string, opts: PlanOptions = {}): Promise<PlanResult> {
  const { villages, carriers, orders, plans } = await loadWorld({ waypoints: false });
  const order = orders.find((o) => o.id === orderId);
  if (!order) throw new Error(`No order ${orderId}`);
  const own = plans.find((p) => p.order_id === orderId)?.carrier_id ?? 0; // re-planning: its own carrier is not "busy"
  const vmap = new Map(villages.map((v) => [v.id, v]));
  const from = vmap.get(order.from_village_id), to = vmap.get(order.to_village_id);
  if (!from || !to) throw new Error(`Order ${orderId} has an unknown village`);
  const kg = weightKg(order.item, order.qty);
  const heavy = HEAVY.has(order.item);
  const what = `${order.qty} ${order.item} (${kg} kg)`;
  const agent = opts.agent ?? "Route planner";
  const watcher = agent !== "Route planner";

  // Same village: someone walks or cycles it across.
  if (from.id === to.id) {
    const pick = pickCarrier(carriers, vmap, from, to, kg, ["bicycle", "motorbike", "pickup"], 2, own);
    const chosen = pick?.c ?? carriers.find((c) => c.kind === "pickup") ?? carriers[0];
    const minutes = minutesFor(2, chosen.speed_kmh);
    const reason = `Within ${short(to.name)}: ${chosen.name} takes it across the village from the health post.`;
    await planRoute({ orderId, carrierId: chosen.id, waypoints: [at(from), at(to)], km: 2, minutes, floodRisk: "low", reason });
    if (!opts.quiet) await logAgent(agent, to.name, `${short(to.name)}: ${what} for ${order.patient_name} → ${chosen.name}, in the village, ~${minutes} min.`);
    const flood: FloodCheck = { risk: "low", reasons: [], stubbed: false, forced: false, weatherRisk: "low", wettestWindowMm: 0, rain72hMm: 0, surface: null };
    return { orderId, carrier: pickFields(chosen), km: 2, minutes, floodRisk: "low", status: "planned", reason, source: "straight", flood, weightKg: kg, surface: null };
  }

  const road = await roadPath(at(from), at(to));
  const surface = await surfaceFor(at(from), at(to));
  const flood = await floodRisk(at(from), at(to), origin, surface);
  const why = (f: FloodCheck) => f.reasons.slice(0, 2).map((r) => (r.length > 110 ? r.slice(0, 107) + "…" : r)).join("; ");
  const kinds = heavy ? ["truck", "pickup"] : ["pickup", "motorbike", "truck", "bicycle"];
  let pick = pickCarrier(carriers, vmap, from, to, kg, kinds, road.main.km, own);
  if (opts.carrierId) {
    const forced = carriers.find((c) => c.id === opts.carrierId && c.capacity_kg >= kg && c.status !== "down");
    if (forced) pick = { c: forced, deadheadKm: Math.round(haversineKm(at(vmap.get(forced.base_village_id) ?? from), at(from)) * 1.5), minutes: minutesFor(road.main.km, forced.speed_kmh), cost: 0 };
  }
  let path: RoadPath = road.main;
  let status: "planned" | "rerouted" = "planned";
  let risk: FloodRisk = flood.risk;
  let reason = "";
  const sourceNote = road.main.source === "google" ? "Google Maps road" : road.main.source === "osrm" ? "OpenStreetMap road (OSRM)" : "straight line ×1.5 (no router reachable)";
  const surfaceNote = surface ? ` (${describeSurface(surface)})` : "";

  if (flood.risk === "high") {
    // 1. Another road, if the router has one and its halves come back dry.
    const alt = (await roadPath(at(from), at(to), { alternatives: true })).alternatives[0];
    let altOk = false;
    if (alt) {
      const mid = alt.points[Math.floor(alt.points.length / 2)];
      const [h1, h2] = await Promise.all([floodRisk(at(from), mid, origin), floodRisk(mid, at(to), origin)]);
      altOk = h1.risk !== "high" && h2.risk !== "high";
      if (altOk) {
        path = alt;
        risk = h1.risk === "medium" || h2.risk === "medium" ? "medium" : "low";
        status = "rerouted";
        pick = pickCarrier(carriers, vmap, from, to, kg, kinds, alt.km, own);
        reason = `Rerouted: the direct road is flooded (${why(flood)}); taking the alternative road${alt.summary ? ` via ${alt.summary}` : ""}, ${alt.km} km instead of ${road.main.km}.`;
      }
    }
    // 2. A carrier that does not need the road. Ground first (motorbike on the tracks, boat on
    //    the Luangwa); a drone only when nothing on the ground can carry it, because no drone
    //    fleet operates in Zambia today.
    if (!altOk) {
      const ground = [
        ...(kg <= 25 && !heavy ? ["motorbike"] : []),
        ...(carriers.some((c) => c.kind === "boat" && c.status !== "down" && boatNear(c, vmap, from, to)) ? ["boat"] : []),
      ];
      const alt2 = (ground.length ? pickCarrier(carriers, vmap, from, to, kg, ground, road.main.km, own) : null) ?? (kg <= 1.8 ? pickCarrier(carriers, vmap, from, to, kg, ["drone"], road.main.km, own) : null);
      if (alt2) {
        pick = alt2;
        status = "rerouted";
        risk = alt2.c.kind === "drone" ? "low" : "medium"; // the water is still there, this carrier gets past it
        const how = alt2.c.kind === "motorbike" ? "a motorbike can use the tracks around the water" : alt2.c.kind === "boat" ? "the boat crosses where the road cannot" : "a drone flies over it (proposed partner, not a fleet Zambia has today)";
        reason = `Rerouted: the road is flooded (${why(flood)}) and the router has no dry alternative; ${how}.`;
      } else {
        reason = `Road flooded (${why(flood)}); nothing lighter can carry ${what}, so the ${pick?.c.kind ?? "truck"} waits for the water to drop.`;
      }
    }
  }
  if (!pick) {
    const any = carriers.filter((c) => c.capacity_kg >= kg && c.status !== "down").sort((a, b) => b.capacity_kg - a.capacity_kg)[0] ?? carriers.find((c) => c.status !== "down") ?? carriers[0];
    pick = { c: any, deadheadKm: 0, minutes: minutesFor(path.km, any.speed_kmh), cost: 0 };
  }
  const chosen = pick.c;
  const points = chosen.kind === "drone" ? [at(from), at(to)] : thin(path.points);
  const km = chosen.kind === "drone" ? Math.round(haversineKm(at(from), at(to)) * 10) / 10 : path.km;
  const minutes = minutesFor(km, chosen.speed_kmh);
  if (!reason) {
    reason = `${chosen.name} (${chosen.operator}): ${heavy ? "heavy item, road vehicle only" : `quickest idle carrier for ${kg} kg`}${pick.deadheadKm ? `, ${pick.deadheadKm} km from its base in ${short(vmap.get(chosen.base_village_id)?.name ?? "")}` : ", already at the pickup"}. ${sourceNote}${path.summary ? ` via ${path.summary}` : ""}, ${km} km${surfaceNote}, ~${minutes} min.${flood.risk === "medium" ? ` Flood risk medium: ${why(flood)}.` : flood.risk === "low" && !flood.stubbed && flood.reasons[0] ? ` Weather: ${flood.reasons[0].slice(0, 110)}.` : ""}${flood.stubbed ? ` (${flood.reasons.find((r) => r.includes("weather check")) ?? "weather check stubbed"})` : ""}`;
  }
  if (watcher) reason = `${reason} Re-checked ${hhmm()}.`;
  await planRoute({ orderId, carrierId: chosen.id, waypoints: points, km, minutes, floodRisk: risk, reason });
  if (!opts.quiet) {
    await logAgent(
      agent,
      to.name,
      `${watcher ? "Re-check: " : ""}${short(from.name)} → ${short(to.name)}: ${what} for ${order.kind === "restock" ? `${short(to.name)} post` : order.patient_name} by ${chosen.name}, ${km} km on ${chosen.kind === "drone" ? "a straight flight" : sourceNote}${surface ? ` (${surface.worstSurface} at worst)` : ""}, ~${minutes} min, flood risk ${risk}${status === "rerouted" ? " → RE-ROUTED" : ""}.`
    );
  }
  return { orderId, carrier: pickFields(chosen), km, minutes, floodRisk: risk, status, reason, source: path.source, flood, weightKg: kg, surface, blocked: flood.blocked ?? null };
}

const pickFields = (c: Carrier) => ({ id: c.id, name: c.name, kind: c.kind, operator: c.operator });
const hhmm = () => new Date().toISOString().slice(11, 16) + "Z";

// Every open order that has no plan yet (or whose plan is older than a re-flood), one by one.
export async function planAllOpen(origin: string, opts: { replan?: boolean } = {}) {
  const { orders, plans } = await loadWorld({ waypoints: false });
  const planned = new Set(plans.map((p) => p.order_id));
  const todo = orders.filter((o) => o.status !== "delivered" && (opts.replan || !planned.has(o.id)));
  const results: (PlanResult | { orderId: number; error: string })[] = [];
  for (const o of todo) {
    try {
      results.push(await planOrder(o.id, origin, { quiet: todo.length > 3 }));
    } catch (e) {
      results.push({ orderId: o.id, error: (e as Error).message });
    }
  }
  if (todo.length > 3) {
    const ok = results.filter((r) => !("error" in r)) as PlanResult[];
    await logAgent("Route planner", "", `Planned ${ok.length} routes: ${ok.filter((r) => r.status === "rerouted").length} re-routed around flooded roads, ${ok.filter((r) => r.carrier.kind === "drone").length} by drone (proposed partner).`);
  }
  return results;
}

// ---- Multi-stop runs ----

// Nearest neighbour from the base, then 2-opt until no swap shortens the tour (return leg included).
export function orderStops<T extends { lat: number; lng: number }>(base: T, stops: T[]): T[] {
  if (stops.length < 2) return [...stops];
  const d = (a: T, b: T) => haversineKm([a.lat, a.lng], [b.lat, b.lng]);
  const left = [...stops];
  const tour: T[] = [];
  let here = base;
  while (left.length) {
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (d(here, left[i]) < d(here, left[bi])) bi = i;
    here = left.splice(bi, 1)[0];
    tour.push(here);
  }
  const full = () => [base, ...tour, base];
  const length = (t: T[]) => t.slice(1).reduce((s, p, i) => s + d(t[i], p), 0);
  let improved = true, guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    const t = full();
    for (let i = 1; i < t.length - 2; i++) {
      for (let k = i + 1; k < t.length - 1; k++) {
        const cand = [...t.slice(0, i), ...t.slice(i, k + 1).reverse(), ...t.slice(k + 1)];
        if (length(cand) + 1e-9 < length(t)) {
          tour.splice(0, tour.length, ...cand.slice(1, -1));
          improved = true;
        }
      }
    }
  }
  return tour;
}

export type RunRequest = { id: string; orderIds: number[]; carrierId?: number };
export type RunLeg = { from: string; to: string; km: number; risk: FloodRisk; rerouted: boolean; surface: RoadSurface | null; reasons: string[]; blocked: boolean };
export type DroppedStop = { villageId: number; name: string; orderIds: number[]; why: string; singles: PlanResult[] };
export type RunPlanResult = {
  runId: string;
  label: string;
  orderIds: number[];
  stops: { villageId: number; name: string; stop: number; orderIds: number[] }[];
  carrier: { id: number; name: string; kind: string; operator: string };
  km: number;
  minutes: number;
  floodRisk: FloodRisk;
  status: "planned" | "rerouted";
  legs: RunLeg[];
  surface: RoadSurface | null;
  reason: string;
  // Stops the road could not reach (a leg still high after the alternative road): their orders were
  // planned one by one instead (motorbike on the tracks, boat on the Luangwa, drone, or "waits").
  dropped: DroppedStop[];
  fellBackToSingles?: PlanResult[];
};

export const runLabel = (id: string) => id.replace(/^run[-\s]?/i, "").toUpperCase();

// A multi-stop run. One stop is still a run (one leg, one plan per order, drawn once); zero stops
// (every order addressed to the base itself) falls back to single plans.
export async function planRun(run: RunRequest, origin: string, opts: { agent?: string } = {}): Promise<RunPlanResult> {
  const { villages, carriers, orders } = await loadWorld({ waypoints: false });
  const vmap = new Map(villages.map((v) => [v.id, v]));
  const mine = run.orderIds.map((id) => orders.find((o) => o.id === Number(id))).filter((o): o is Order => !!o);
  if (!mine.length) throw new Error(`Run ${run.id}: none of the orders exist`);
  const agent = opts.agent ?? "Route planner";
  const label = runLabel(run.id);
  // The base: where most of the orders leave from (the hub, or a lending post).
  const fromCount = new Map<number, number>();
  for (const o of mine) fromCount.set(o.from_village_id, (fromCount.get(o.from_village_id) ?? 0) + 1);
  const baseId = [...fromCount].sort((a, b) => b[1] - a[1])[0][0];
  const base = vmap.get(baseId);
  if (!base) throw new Error(`Run ${run.id}: unknown base village ${baseId}`);
  const stopIds = [...new Set(mine.map((o) => o.to_village_id).filter((id) => id !== base.id))];
  let stopVillages = stopIds.map((id) => vmap.get(id)).filter((v): v is Village => !!v);
  const inBase = mine.filter((o) => o.to_village_id === base.id);
  const singles: PlanResult[] = [];
  for (const o of inBase) singles.push(await planOrder(o.id, origin, { quiet: true, agent })); // a walk across the base village
  if (!stopVillages.length) {
    const s = singles[0];
    return { runId: run.id, label, orderIds: mine.map((o) => o.id), stops: [], carrier: s.carrier, km: s.km, minutes: s.minutes, floodRisk: s.floodRisk, status: s.status, legs: [], surface: s.surface, reason: s.reason, dropped: [], fellBackToSingles: singles };
  }

  const dropped: DroppedStop[] = [];
  const kgOf = (list: Order[]) => Math.round(list.reduce((s, o) => s + weightKg(o.item, o.qty), 0) * 100) / 100;
  let kg = kgOf(mine.filter((o) => o.to_village_id !== base.id));
  const pickRunCarrier = (tour: Village[]) => {
    let carrier = run.carrierId ? carriers.find((c) => c.id === run.carrierId && c.status !== "down") : undefined;
    if (!carrier || carrier.capacity_kg < kg) {
      const pick = pickCarrier(carriers, vmap, base, tour[0], kg, ["truck", "pickup"], tour.reduce((s, v, i) => s + haversineKm(at(i ? tour[i - 1] : base), at(v)) * 1.5, 0));
      carrier = pick?.c ?? carriers.filter((c) => (c.kind === "truck" || c.kind === "pickup") && c.status !== "down" && c.capacity_kg >= kg).sort((a, b) => b.capacity_kg - a.capacity_kg)[0] ?? carriers.find((c) => c.kind === "truck" && c.status !== "down") ?? carriers.find((c) => c.status !== "down") ?? carriers[0];
    }
    return carrier;
  };

  // One road per leg, each checked for flood (weather + road_block) and surface; a high leg tries
  // the router's alternative road. A leg still high after that makes its stop unreachable by this
  // run: the stop is dropped, its orders go one by one (planOrder switches to a motorbike, a boat, a
  // drone, or lets a heavy load wait), and the tour is built again without it.
  let tour: Village[] = [];
  let legs: RunLeg[] = [];
  let points: LatLng[] = [];
  let surfaces: (RoadSurface | null)[] = [];
  let km = 0, anyRerouted = false;
  for (let attempt = 0; attempt <= stopIds.length && stopVillages.length; attempt++) {
    tour = orderStops(base, stopVillages);
    legs = []; points = []; surfaces = []; km = 0; anyRerouted = false;
    let prev = base, unreachable: Village | null = null, unreachableWhy = "";
    for (const stop of tour) {
      const road = await roadPath(at(prev), at(stop));
      const surface = await surfaceFor(at(prev), at(stop));
      const flood = await floodRisk(at(prev), at(stop), origin, surface);
      let path = road.main, risk = flood.risk, rerouted = false, reasons = flood.reasons.slice(0, 2);
      if (flood.risk === "high") {
        const alt = (await roadPath(at(prev), at(stop), { alternatives: true })).alternatives[0];
        if (alt) {
          const mid = alt.points[Math.floor(alt.points.length / 2)];
          const [h1, h2] = await Promise.all([floodRisk(at(prev), mid, origin), floodRisk(mid, at(stop), origin)]);
          if (h1.risk !== "high" && h2.risk !== "high") {
            path = alt;
            risk = h1.risk === "medium" || h2.risk === "medium" ? "medium" : "low";
            rerouted = true;
            anyRerouted = true;
            reasons = [`direct road flooded (${flood.reasons[0]?.slice(0, 90) ?? "flood check high"}); alternative road${alt.summary ? ` via ${alt.summary}` : ""}, ${alt.km} km instead of ${road.main.km}`];
          }
        }
        if (risk === "high") { unreachable = stop; unreachableWhy = flood.reasons[0] ?? "flood check high"; break; }
      }
      legs.push({ from: short(prev.name), to: short(stop.name), km: path.km, risk, rerouted, surface, reasons, blocked: !!flood.blocked });
      surfaces.push(surface);
      const pts = path.points;
      points.push(...(points.length ? pts.slice(1) : pts));
      km = Math.round((km + path.km) * 10) / 10;
      prev = stop;
    }
    if (!unreachable) break;
    const dropIds = mine.filter((o) => o.to_village_id === unreachable!.id).map((o) => o.id);
    const got: PlanResult[] = [];
    for (const oid of dropIds) got.push(await planOrder(oid, origin, { quiet: true, agent }));
    dropped.push({ villageId: unreachable.id, name: short(unreachable.name), orderIds: dropIds, why: unreachableWhy, singles: got });
    stopVillages = stopVillages.filter((v) => v.id !== unreachable!.id);
    kg = kgOf(mine.filter((o) => o.to_village_id !== base.id && stopVillages.some((v) => v.id === o.to_village_id)));
    await logAgent(agent, unreachable.name, `${agent !== "Route planner" ? "Re-check: " : ""}Run ${label} cannot reach ${short(unreachable.name)} by road (${unreachableWhy.slice(0, 120)}): its ${dropIds.length} order${dropIds.length === 1 ? "" : "s"} go ${describeSingles(got)}.`).catch(() => undefined);
  }
  const droppedText = dropped.length ? ` Skipped by road: ${dropped.map((d) => `${d.name} (${d.why.slice(0, 70)}; ${d.orderIds.length} order${d.orderIds.length === 1 ? "" : "s"} ${describeSingles(d.singles)})`).join("; ")}.` : "";
  if (!tour.length || !stopVillages.length) {
    // Every stop was unreachable by road: the run dissolved into single plans.
    const all = [...singles, ...dropped.flatMap((d) => d.singles)];
    const s = all[0];
    const worst = all.reduce<FloodRisk>((w, r) => (RANK[r.floodRisk] > RANK[w] ? r.floodRisk : w), "low");
    await logAgent(agent, base.name, `Run ${label} from ${short(base.name)}: no stop reachable by road.${droppedText}`).catch(() => undefined);
    return { runId: run.id, label, orderIds: mine.map((o) => o.id), stops: [], carrier: s.carrier, km: Math.round(all.reduce((t, r) => t + r.km, 0) * 10) / 10, minutes: Math.max(...all.map((r) => r.minutes)), floodRisk: worst, status: all.some((r) => r.status === "rerouted") ? "rerouted" : "planned", legs: [], surface: null, reason: `run ${label}: every stop unreachable by road from ${short(base.name)}; ${all.length} orders planned one by one.${droppedText}`, dropped, fellBackToSingles: all };
  }
  const carrier = pickRunCarrier(tour);
  const risk = legs.reduce<FloodRisk>((w, l) => (RANK[l.risk] > RANK[w] ? l.risk : w), "low");
  const minutes = minutesFor(km, carrier.speed_kmh) + STOP_MINUTES * tour.length;
  const surface = sumSurfaces(surfaces);
  const status: "planned" | "rerouted" = anyRerouted ? "rerouted" : "planned";
  const tourText = `${short(base.name)} → ${tour.map((v) => short(v.name)).join(" → ")}`;
  const worstLeg = legs.find((l) => l.risk === risk);
  const weatherText = risk === "low" ? (worstLeg?.reasons[0] ? ` Weather: ${worstLeg.reasons[0].slice(0, 100)}.` : "") : ` Flood risk ${risk} on ${worstLeg?.from} → ${worstLeg?.to}: ${worstLeg?.reasons[0]?.slice(0, 100) ?? ""}.`;
  const legsText = legs.map((l) => `${l.to} ${l.km} km${l.surface ? `, ${l.surface.worstSurface}` : ""}`).join("; ");
  const stops = tour.map((v, i) => ({ villageId: v.id, name: short(v.name), stop: i + 1, orderIds: mine.filter((o) => o.to_village_id === v.id).map((o) => o.id) }));
  const waypoints = thin(points);
  for (const s of stops) {
    for (const oid of s.orderIds) {
      const o = mine.find((x) => x.id === oid)!;
      const reason = `${anyRerouted ? "Rerouted: " : ""}run ${label} stop ${s.stop} of ${stops.length} (${tourText}): ${carrier.name} (${carrier.operator}) carries ${kg} kg for ${stops.length} post${stops.length === 1 ? "" : "s"}, ${km} km on OpenStreetMap roads${surface ? ` (${describeSurface(surface)})` : ""}, ~${minutes} min with ${STOP_MINUTES} min a stop. Legs: ${legsText}.${weatherText}${anyRerouted ? ` Re-routed legs: ${legs.filter((l) => l.rerouted).map((l) => `${l.from} → ${l.to}: ${l.reasons[0]}`).join("; ")}.` : ""}${droppedText}${agent !== "Route planner" ? ` Re-checked ${hhmm()}.` : ""} This order: ${o.qty} ${o.item} for ${short(s.name)}.`;
      await planRoute({ orderId: oid, carrierId: carrier.id, waypoints, km, minutes, floodRisk: risk, reason });
    }
  }
  const reason = `run ${label}: ${tourText} by ${carrier.name}, ${km} km, ~${minutes} min, ${stops.reduce((n, s) => n + s.orderIds.length, 0)} orders, flood risk ${risk}${anyRerouted ? " (a leg re-routed)" : ""}${dropped.length ? ` (${dropped.length} stop${dropped.length === 1 ? "" : "s"} unreachable by road, planned one by one)` : ""}`;
  await logAgent(agent, base.name, `${agent !== "Route planner" ? "Re-check: " : ""}Run ${label}: ${tourText} by ${carrier.name} (${carrier.kind}), ${mine.length} orders, ${kg} kg, ${km} km on OpenStreetMap roads${surface ? ` (${describeSurface(surface)})` : ""}, ~${minutes} min, flood risk ${risk}${anyRerouted ? " → a leg RE-ROUTED" : ""}. Stops ordered nearest-neighbour then 2-opt.${droppedText}`);
  return { runId: run.id, label, orderIds: mine.map((o) => o.id), stops, carrier: pickFields(carrier), km, minutes, floodRisk: risk, status, legs, surface, reason, dropped, fellBackToSingles: singles.length ? singles : undefined };
}

// "by boat (2), by motorbike (1)" / "wait for the water to drop (truck)".
export function describeSingles(list: PlanResult[]) {
  const by = new Map<string, number>();
  for (const r of list) {
    const key = r.floodRisk === "high" && r.status !== "rerouted" ? `wait for the water to drop (${r.carrier.kind})` : `by ${r.carrier.kind}${r.status === "rerouted" ? "" : " on the direct road"}`;
    by.set(key, (by.get(key) ?? 0) + 1);
  }
  return [...by].map(([k, n]) => `${k} (${n})`).join(", ") || "nowhere";
}

// ---- Re-checking live plans against the latest weather ----

export type RecheckResult = {
  at: string;
  checked: number;
  rerouted: { orderId: number; run: string | null; from: string; to: string; before: string; after: string; reason: string }[];
  changed: { orderId: number; from: string; to: string; before: string; after: string }[];
  errors: string[];
};

let lastRecheck: RecheckResult | null = null;
export const getLastRecheck = () => lastRecheck;

const RUN_RE = /run ([A-Z0-9]+) stop (\d+) of (\d+) \(([^)]+)\)/;

// Every plan that is not done, scored again against the current /api/weather/road answer and the
// measured surface. A leg that moved to high is planned again (alternative road, else a carrier
// that does not need the road) and marked `rerouted`; a level that merely shifted (low ↔ medium)
// is written on the plan without touching the carrier or the road. Runs are re-checked leg by leg
// (the tour is in their reason) and re-planned whole.
export async function recheckAll(origin: string): Promise<RecheckResult> {
  const { villages, orders, plans } = await loadWorld();
  const vmap = new Map(villages.map((v) => [v.id, v]));
  const byShort = new Map(villages.map((v) => [short(v.name).toLowerCase(), v]));
  const omap = new Map(orders.map((o) => [o.id, o]));
  const out: RecheckResult = { at: new Date().toISOString(), checked: 0, rerouted: [], changed: [], errors: [] };
  const live = plans.filter((p) => p.status !== "done" && omap.get(p.order_id) && omap.get(p.order_id)!.status !== "delivered");
  const seenRuns = new Set<string>();
  for (const p of live) {
    const o = omap.get(p.order_id)!;
    const from = vmap.get(o.from_village_id), to = vmap.get(o.to_village_id);
    if (!from || !to || from.id === to.id) continue;
    const before = (["low", "medium", "high"].includes(p.flood_risk) ? p.flood_risk : "low") as FloodRisk;
    try {
      const m = RUN_RE.exec(p.reason);
      if (m) {
        const runKey = `${m[1]}|${m[4]}`;
        if (seenRuns.has(runKey)) continue; // one check per run, not per order
        seenRuns.add(runKey);
        const names = m[4].split("→").map((s) => s.trim().toLowerCase());
        const tour = names.map((n) => byShort.get(n)).filter((v): v is Village => !!v);
        const runOrders = live.filter((q) => RUN_RE.exec(q.reason)?.[1] === m[1] && RUN_RE.exec(q.reason)?.[4] === m[4]).map((q) => q.order_id);
        out.checked += runOrders.length;
        let worst: FloodRisk = "low", worstBlocked = false;
        for (let i = 1; i < tour.length; i++) {
          const f = await floodRisk(at(tour[i - 1]), at(tour[i]), origin, await cachedSurface(at(tour[i - 1]), at(tour[i])));
          if (RANK[f.risk] > RANK[worst]) { worst = f.risk; worstBlocked = !!f.blocked; }
        }
        // A run already re-routed around a standing road block (alternative road) stays as it is:
        // the direct road is still blocked, which is exactly why it was re-routed.
        const alreadyAround = (p.status === "rerouted" || /^rerouted/i.test(p.reason)) && worstBlocked && before !== "high";
        if (worst === "high" && before !== "high" && !alreadyAround) {
          const r = await planRun({ id: m[1], orderIds: runOrders, carrierId: p.carrier_id }, origin, { agent: "Route watcher" });
          for (const oid of runOrders) out.rerouted.push({ orderId: oid, run: m[1], from: short(from.name), to: short(vmap.get(omap.get(oid)!.to_village_id)?.name ?? ""), before, after: r.floodRisk, reason: r.reason });
        } else if (worst !== before && p.status !== "moving" && !alreadyAround) {
          for (const oid of runOrders) {
            const q = plans.find((x) => x.order_id === oid)!;
            await planRoute({ orderId: oid, carrierId: q.carrier_id, waypoints: JSON.parse(q.waypoints || "[]"), km: q.km, minutes: q.minutes, floodRisk: worst, reason: `${q.reason.replace(/ Re-checked [^.]*\.$/, "")} Re-checked ${hhmm()}: flood risk now ${worst}.` });
            out.changed.push({ orderId: oid, from: short(from.name), to: short(to.name), before, after: worst });
          }
        }
        continue;
      }
      out.checked++;
      const f = await floodRisk(at(from), at(to), origin, await cachedSurface(at(from), at(to)));
      // Already re-routed around a standing block (another carrier or another road): leave it.
      const alreadyAround = (p.status === "rerouted" || /^rerouted/i.test(p.reason)) && !!f.blocked && before !== "high";
      if (f.risk === "high" && before !== "high" && !alreadyAround) {
        const r = await planOrder(o.id, origin, { agent: "Route watcher" });
        out.rerouted.push({ orderId: o.id, run: null, from: short(from.name), to: short(to.name), before, after: r.floodRisk, reason: r.reason });
      } else if (f.risk !== before && p.status !== "moving" && !alreadyAround) {
        await planRoute({ orderId: o.id, carrierId: p.carrier_id, waypoints: JSON.parse(p.waypoints || "[]"), km: p.km, minutes: p.minutes, floodRisk: f.risk, reason: `${p.reason.replace(/ Re-checked [^.]*\.$/, "")} Re-checked ${hhmm()}: flood risk now ${f.risk}${f.reasons[0] ? ` (${f.reasons[0].slice(0, 90)})` : ""}.` });
        out.changed.push({ orderId: o.id, from: short(from.name), to: short(to.name), before, after: f.risk });
      }
    } catch (e) {
      out.errors.push(`order ${o.id}: ${(e as Error).message}`);
    }
  }
  if (out.rerouted.length || out.changed.length) {
    await logAgent("Route watcher", "", `Re-checked ${out.checked} live route${out.checked === 1 ? "" : "s"} against the latest forecast and road surfaces: ${out.rerouted.length} re-routed${out.rerouted.length ? ` (${[...new Set(out.rerouted.map((r) => `${r.from} → ${r.to}`))].slice(0, 3).join(", ")})` : ""}, ${out.changed.length} changed level.`).catch(() => undefined);
  }
  lastRecheck = out;
  return out;
}
