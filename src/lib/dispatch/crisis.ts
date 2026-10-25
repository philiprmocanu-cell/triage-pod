import fs from "node:fs/promises";
import path from "node:path";
import { ITEM_KG, planDispatch, type DispatchPlan, type Shipment } from "./plan";
import { callReducer, loadState, sql } from "./state";
import { roadBlocks, type RoadBlock } from "@/lib/routes/flood";
import { planOrder, planRun, recheckAll, runLabel, type PlanResult, type RecheckResult, type RunPlanResult } from "@/lib/routes/planner";
import { haversineKm, minutesFor, roadPath, type LatLng } from "@/lib/routes/router";

// The crisis drill, end to end, on the live tables: start the situation in the module
// (start_crisis), run the dispatch planner on it, place every shipment (emergencies first), plan
// all the roads as multi-stop runs, run the route watcher once more, then measure what the
// planner did against the naive plan (every order its own trip straight from the hub). Nothing
// here is invented: every count below is read back from SpacetimeDB or from the planner's own
// results. Progress is kept in memory so GET /api/crisis/status can show the steps as they run.

export type CrisisStep = { n: number; title: string; detail: string; startedAt: string; ms: number | null; status: "running" | "done" | "failed" };
export type Lent = { lender: string; lenderId: number; items: { item: string; qty: number; to: string }[]; qty: number };
export type Unreachable = { post: string; villageId: number; why: string; instead: string; orders: number };
export type FoundWay = { leg: string; risk: string; reason: string; outcomes: string[] };
export type CrisisTotals = {
  level: number;
  postsHit: number;
  redVisits: number;
  yellowVisits: number;
  shelvesEmptied: number;
  blocks: number;
  carriersDown: number;
  postsInNeed: number;
  orders: number;
  patientOrders: number;
  restockOrders: number;
  items: number;
  kg: number;
  shipments: number;
  shipmentsByTier: Record<string, number>;
  runs: number; // multi-stop runs (two or more posts on one road)
  trips: number; // distinct vehicle movements (a run counts once)
  carriersUsed: number;
  carriersByKind: Record<string, number>;
  kmTotal: number;
  minutesTotal: number;
  naiveTrips: number;
  naiveKm: number;
  naiveMinutes: number;
  kmSaved: number;
  minutesSaved: number;
  legsRerouted: number; // legs that took the alternative road
  tripsRerouted: number; // trips marked rerouted (alternative road or another carrier)
  recheck: { checked: number; rerouted: number; changed: number };
  unreachable: Unreachable[];
  lent: Lent[];
  found: FoundWay[];
  notes: string[];
  delivered: number;
  totalMs: number;
};
export type CrisisRun = { level: number; startedAt: string; finishedAt: string | null; running: boolean; steps: CrisisStep[]; totals: CrisisTotals | null; error: string | null };

// The run in progress (or the last one). Next's dev server can re-create this module while a run
// is going, so every step is also written to data/crisis.json and read back from there when the
// memory is empty: the page keeps seeing the live steps either way.
let current: CrisisRun | null = null;
let running: Promise<CrisisRun> | null = null;
const FILE = () => path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "crisis.json");
let persistChain: Promise<void> = Promise.resolve();
function persist(run: CrisisRun) {
  const snapshot = JSON.stringify(run);
  persistChain = persistChain.then(() => fs.writeFile(FILE(), snapshot)).catch(() => undefined);
}
export async function getCrisisRun(): Promise<CrisisRun | null> {
  if (current) return current;
  try {
    const saved = JSON.parse(await fs.readFile(FILE(), "utf8")) as CrisisRun;
    // A run that was left "running" by a module reload more than five minutes ago is not running.
    if (saved.running && Date.now() - Date.parse(saved.startedAt) > 5 * 60_000) { saved.running = false; saved.error = saved.error ?? "the server reloaded while this run was going; the tables hold whatever it finished"; }
    return saved;
  } catch {
    return null;
  }
}
export const isCrisisRunning = () => !!running;

type OrderRow = { id: number; kind: string; patient_name: string; to_village_id: number; from_village_id: number; item: string; qty: number; mode: string; status: string; created_at: unknown };
type PlanRow = { id: number; order_id: number; carrier_id: number; waypoints: string; km: number; minutes: number; flood_risk: string; status: string; reason: string };
type VillageRow = { id: number; name: string; lat: number; lng: number; hub: boolean };
type CarrierRow = { id: number; name: string; kind: string; status: string };

const short = (name: string) => name.replace(/ \(.*\)$/, "");
const micros = (v: unknown) => (Array.isArray(v) && typeof v[0] === "number" ? Number(v[0]) : typeof v === "number" ? v : 0);
const RUN_RE = /run ([A-Z0-9]+) stop (\d+) of (\d+) \(([^)]+)\)/;
const CONCURRENCY = 4; // runs planned at once (OSRM calls queue on their own; the rest is local)

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

export async function runCrisis(level: number, origin: string): Promise<CrisisRun> {
  if (running) return running;
  running = run(level, origin).finally(() => { running = null; });
  return running;
}

async function run(levelIn: number, origin: string): Promise<CrisisRun> {
  const level = Math.max(1, Math.min(3, Math.round(levelIn) || 3));
  const t0 = Date.now();
  const me: CrisisRun = { level, startedAt: new Date().toISOString(), finishedAt: null, running: true, steps: [], totals: null, error: null };
  current = me;
  persist(me);
  const step = (title: string, detail = "") => {
    const s: CrisisStep = { n: me.steps.length + 1, title, detail, startedAt: new Date().toISOString(), ms: null, status: "running" };
    me.steps.push(s);
    persist(me);
    const begun = Date.now();
    return { done: (d: string) => { s.detail = d; s.ms = Date.now() - begun; s.status = "done"; persist(me); }, fail: (d: string) => { s.detail = d; s.ms = Date.now() - begun; s.status = "failed"; persist(me); } };
  };
  try {
    // 1. The situation, in one transaction.
    const s1 = step("Start the crisis", `Level ${level}: visits, empty shelves, roads under water, carriers down, in one SpacetimeDB transaction.`);
    const maxBefore = Math.max(0, ...(await sql("SELECT id FROM delivery_order")).map((r) => Number(r.id)));
    await callReducer("start_crisis", [level]);
    const crisisRow = (await sql("SELECT * FROM crisis"))[0];
    if (!crisisRow) throw new Error("start_crisis ran but no crisis row appeared");
    const startedUs = micros(crisisRow.started_at);
    const patientOrders = (await sql(`SELECT id, to_village_id FROM delivery_order WHERE id > ${maxBefore}`)).map((r) => ({ id: Number(r.id), to: Number(r.to_village_id) }));
    const blocks = await roadBlocks();
    s1.done(`${crisisRow.posts_hit} posts hit: ${crisisRow.red_visits} red and ${crisisRow.yellow_visits} yellow visits, ${patientOrders.length} patient orders already asked for, ${crisisRow.stock_outs} shelves emptied, ${blocks.length} roads blocked (${blocks.filter((b) => b.risk === "high").length} under water), ${crisisRow.carriers_down} carriers in the workshop. Simulation and agents off.`);

    // 2. The dispatch brain.
    const s2 = step("Run the dispatch planner", "Reading every shelf, visit, order, the forecast and the fleet from the live tables.");
    const state = await loadState(origin);
    const plan: DispatchPlan = planDispatch(state);
    const lenders = new Map<number, number>();
    for (const sh of plan.shipments) for (const i of sh.items) if (i.fromVillageId) lenders.set(i.fromVillageId, (lenders.get(i.fromVillageId) ?? 0) + i.qty);
    const tiers = plan.counts;
    s2.done(`${plan.shipments.length} shipments for ${tiers.posts} posts: ${tiers.emergency} emergency, ${tiers.urgent} urgent, ${tiers["pre-position"] + tiers["pre-position-seasonal"]} pre-position, ${tiers.routine} routine; ${tiers.items} items, ${tiers.kg} kg; ${plan.runs.length} batched runs; ${lenders.size ? `${[...lenders].map(([id, q]) => `${state.posts.find((p) => p.id === id)?.name ?? id} lends ${q}`).join(", ")}` : "nothing lent between posts"}. ${plan.notes.length} things it could not do.`);

    // 3. Place the orders, emergencies first (the plan is already ranked).
    const s3 = step("Place the orders, emergencies first", `${plan.shipments.length} shipments → restock orders on the network.`);
    const hubId = state.posts.find((p) => p.hub)?.id ?? 1;
    const maxBeforeRestock = Math.max(maxBefore, ...patientOrders.map((o) => o.id));
    let placed = 0, failed = 0;
    for (const sh of plan.shipments) {
      const reason = `${sh.priority}: ${sh.why[0]}`;
      for (const i of sh.items) {
        try {
          await callReducer("restock", [sh.toVillageId, i.fromVillageId ?? (sh.fromVillageId !== sh.toVillageId ? sh.fromVillageId : hubId), i.item, i.qty, `${reason}; ${i.why}`]);
          placed++;
        } catch {
          failed++;
        }
      }
    }
    const restockRows = (await sql(`SELECT id, to_village_id, from_village_id, item FROM delivery_order WHERE id > ${maxBeforeRestock}`)).map((r) => ({ id: Number(r.id), to: Number(r.to_village_id), from: Number(r.from_village_id), item: String(r.item) }));
    const emergencies = plan.shipments.filter((s) => s.priority === "emergency" || s.priority === "urgent");
    s3.done(`${restockRows.length} restock orders placed (${placed} reducer calls${failed ? `, ${failed} refused` : ""}); the first ${emergencies.length} shipments were emergencies and urgent requests, ${restockRows.filter((o) => o.from !== hubId).length} orders leave from a lending post instead of the hub.`);

    // 4. The roads: batched runs as planned, emergencies as one trip per post (patient orders ride along).
    const s4 = step("Plan the roads", "One road per run through its stops (nearest-neighbour then 2-opt); every leg checked against the weather, the road surface and the road_block table.");
    const byToItem = new Map<string, Shipment>();
    for (const sh of plan.shipments) for (const i of sh.items) byToItem.set(`${sh.toVillageId}|${i.item}`, sh);
    const byTo = new Map<number, Shipment>();
    for (const sh of plan.shipments) if (!byTo.has(sh.toVillageId) || sh.priority === "emergency") byTo.set(sh.toVillageId, sh);
    type Group = { id: string; orderIds: number[]; carrierId?: number; kind: "run" | "trip" };
    const groups = new Map<string, Group>();
    const singles: number[] = [];
    let e = 0;
    const tripKey = (from: number, to: number) => `trip:${from}:${to}`;
    const add = (key: string, make: () => Group, oid: number) => {
      let g = groups.get(key);
      if (!g) { g = make(); groups.set(key, g); }
      g.orderIds.push(oid);
    };
    for (const o of restockRows) {
      const sh = byToItem.get(`${o.to}|${o.item}`);
      if (sh?.run) {
        const label = runLabel(sh.run) + (o.from === hubId ? "" : "2"); // orders a lender sends ride their own run from the lender
        add(`run:${label}`, () => ({ id: label, orderIds: [], carrierId: o.from === hubId ? sh.carrierId ?? undefined : undefined, kind: "run" }), o.id);
      } else {
        add(tripKey(o.from, o.to), () => ({ id: `E${++e}`, orderIds: [], carrierId: sh?.carrierId ?? undefined, kind: "trip" }), o.id);
      }
    }
    const patientRows = (await sql(`SELECT id, to_village_id, from_village_id, status FROM delivery_order WHERE id > ${maxBefore} AND id <= ${maxBeforeRestock}`)).map((r) => ({ id: Number(r.id), to: Number(r.to_village_id), from: Number(r.from_village_id), status: String(r.status) }));
    for (const o of patientRows) {
      if (o.status === "delivered") continue;
      if (o.from === o.to) { singles.push(o.id); continue; }
      add(tripKey(o.from, o.to), () => ({ id: `E${++e}`, orderIds: [], carrierId: byTo.get(o.to)?.carrierId ?? undefined, kind: "trip" }), o.id);
    }
    const list = [...groups.values()].sort((a, b) => Number(b.kind === "trip") - Number(a.kind === "trip")); // emergencies' trips first
    const runResults: (RunPlanResult | { error: string; id: string })[] = await pool(list, CONCURRENCY, async (g) => {
      let lastErr = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await planRun({ id: g.id, orderIds: g.orderIds, carrierId: g.carrierId }, origin);
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err); // a busy database answers late now and then: one more go
        }
      }
      return { error: lastErr, id: g.id };
    });
    const singleResults: PlanResult[] = [];
    for (const oid of singles) {
      try {
        singleResults.push(await planOrder(oid, origin, { quiet: true }));
      } catch {
        // a walk across the village that failed to plan is not worth stopping for
      }
    }
    const okRuns = runResults.filter((r): r is RunPlanResult => !("error" in r));
    const errs = runResults.filter((r): r is { error: string; id: string } => "error" in r);
    const multi = okRuns.filter((r) => r.stops.length >= 2);
    const droppedAll = okRuns.flatMap((r) => r.dropped);
    const legsRerouted = okRuns.reduce((n, r) => n + r.legs.filter((l) => l.rerouted).length, 0);
    s4.done(`${okRuns.length} trips planned on real roads: ${multi.length} multi-stop runs (${multi.reduce((n, r) => n + r.stops.length, 0)} stops) and ${okRuns.length - multi.length} direct trips; ${legsRerouted} legs took the alternative road; ${droppedAll.length} stops could not be reached by road and went another way (${[...new Set(droppedAll.map((d) => d.name))].join(", ") || "none"}); ${singleResults.length} walks within a village${errs.length ? `; ${errs.length} failed (${errs.map((x) => `${x.id}: ${x.error.slice(0, 80)}`).join("; ")})` : ""}.`);

    // 5. The route watcher, once more over everything live.
    const s5 = step("Re-check every live route", "The watcher scores every plan again against the forecast, the road surface and the blocks.");
    let recheck: RecheckResult = { at: "", checked: 0, rerouted: [], changed: [], errors: [] };
    try {
      recheck = await recheckAll(origin);
      s5.done(`${recheck.checked} live routes re-checked: ${recheck.rerouted.length} re-routed, ${recheck.changed.length} changed level${recheck.errors.length ? `, ${recheck.errors.length} errors` : ""}.`);
    } catch (err) {
      s5.fail(`re-check failed: ${err instanceof Error ? err.message : err}`);
    }

    // 6. Measure it against the naive plan.
    const s6 = step("Measure against the naive plan", "Naive: every order is its own trip, straight from the hub on the direct road, by a district pickup.");
    const totals = await measure({ level, startedUs, crisisRow, plan, okRuns, singleResults, recheck, blocks, hubId, t0 });
    me.totals = totals;
    s6.done(`${totals.trips} trips for ${totals.orders} orders (${totals.kmTotal} km, ${hhmm(totals.minutesTotal)}) against ${totals.naiveTrips} naive trips (${totals.naiveKm} km, ${hhmm(totals.naiveMinutes)}): ${totals.kmSaved} km and ${hhmm(totals.minutesSaved)} saved; ${totals.carriersUsed} carriers used; ${totals.unreachable.length} posts unreachable by road served another way; ${totals.lent.reduce((n, l) => n + l.qty, 0)} units lent between posts. Whole run ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
  } catch (err) {
    me.error = err instanceof Error ? err.message : String(err);
    const last = me.steps[me.steps.length - 1];
    if (last && last.status === "running") { last.status = "failed"; last.detail = me.error; last.ms = Date.now() - Date.parse(last.startedAt); }
  }
  me.running = false;
  me.finishedAt = new Date().toISOString();
  persist(me);
  await persistChain;
  return me;
}

const hhmm = (m: number) => (m >= 90 ? `${Math.round(m / 6) / 10} h` : `${Math.round(m)} min`);

async function measure(x: { level: number; startedUs: number; crisisRow: Record<string, unknown>; plan: DispatchPlan; okRuns: RunPlanResult[]; singleResults: PlanResult[]; recheck: RecheckResult; blocks: RoadBlock[]; hubId: number; t0: number }): Promise<CrisisTotals> {
  const [villages, carriers, ordersAll, plansAll] = await Promise.all([
    sql("SELECT * FROM village") as Promise<unknown[]> as Promise<VillageRow[]>,
    sql("SELECT id, name, kind, status FROM carrier") as Promise<unknown[]> as Promise<CarrierRow[]>,
    sql("SELECT * FROM delivery_order") as Promise<unknown[]> as Promise<OrderRow[]>,
    sql("SELECT id, order_id, carrier_id, waypoints, km, minutes, flood_risk, status, reason FROM route_plan") as Promise<unknown[]> as Promise<PlanRow[]>,
  ]);
  const vmap = new Map(villages.map((v) => [Number(v.id), v]));
  const cmap = new Map(carriers.map((c) => [Number(c.id), c]));
  const hub = vmap.get(x.hubId)!;
  const name = (id: number) => short(vmap.get(id)?.name ?? `#${id}`);
  const orders = ordersAll.filter((o) => micros(o.created_at) >= x.startedUs).map((o) => ({ ...o, id: Number(o.id), to_village_id: Number(o.to_village_id), from_village_id: Number(o.from_village_id), qty: Number(o.qty) }));
  const orderIds = new Set(orders.map((o) => o.id));
  const plans = plansAll.filter((p) => orderIds.has(Number(p.order_id)));
  // One trip = one vehicle on one road: every order of a run shares the carrier and the waypoints.
  const trips = new Map<string, PlanRow & { orders: number }>();
  for (const p of plans) {
    const key = `${p.carrier_id}|${p.waypoints}`;
    const t = trips.get(key);
    if (t) t.orders++;
    else trips.set(key, { ...p, orders: 1 });
  }
  const tripList = [...trips.values()];
  const kmTotal = r1(tripList.reduce((s, t) => s + Number(t.km), 0));
  const minutesTotal = Math.round(tripList.reduce((s, t) => s + Number(t.minutes), 0));
  const carriersUsed = new Set(tripList.map((t) => t.carrier_id));
  const carriersByKind: Record<string, number> = {};
  for (const id of carriersUsed) { const k = cmap.get(id)?.kind ?? "?"; carriersByKind[k] = (carriersByKind[k] ?? 0) + 1; }
  const runLabels = new Set<string>();
  for (const p of plans) { const m = RUN_RE.exec(p.reason); if (m && Number(m[3]) >= 2) runLabels.add(m[1]); }
  // Naive: each order straight from the hub on the direct road, one trip each, by a pickup (60 km/h), 20 min to load.
  let naiveKm = 0, naiveMinutes = 0, naiveTrips = 0;
  const away = orders.filter((o) => o.from_village_id !== o.to_village_id);
  const roadKm = new Map<number, number>();
  for (const o of away) {
    const to = vmap.get(o.to_village_id);
    if (!to) continue;
    let km = roadKm.get(to.id);
    if (km === undefined) {
      try {
        km = (await roadPath([hub.lat, hub.lng], [to.lat, to.lng])).main.km;
      } catch {
        km = r1(haversineKm([hub.lat, hub.lng] as LatLng, [to.lat, to.lng] as LatLng) * 1.5);
      }
      roadKm.set(to.id, km);
    }
    naiveKm += km;
    naiveMinutes += minutesFor(km, 60) + 20;
    naiveTrips++;
  }
  naiveKm = r1(naiveKm);
  // What was lent between posts (orders that leave from a post, not the hub).
  const lentMap = new Map<number, Lent>();
  for (const o of orders) {
    if (o.kind !== "restock" || o.from_village_id === x.hubId || o.from_village_id === o.to_village_id) continue;
    let l = lentMap.get(o.from_village_id);
    if (!l) { l = { lender: name(o.from_village_id), lenderId: o.from_village_id, items: [], qty: 0 }; lentMap.set(o.from_village_id, l); }
    l.items.push({ item: o.item, qty: o.qty, to: name(o.to_village_id) });
    l.qty += o.qty;
  }
  // Posts the road could not reach, and what went instead.
  const unreachable: Unreachable[] = [];
  for (const r of x.okRuns) for (const d of r.dropped) {
    const prev = unreachable.find((u) => u.villageId === d.villageId);
    if (prev) { prev.orders += d.orderIds.length; continue; }
    unreachable.push({ post: d.name, villageId: d.villageId, why: d.why, instead: describe(d.singles), orders: d.orderIds.length });
  }
  // How it found a way: per blocked leg, what the planner did about it.
  const found: FoundWay[] = x.blocks.map((b) => ({ leg: `${b.from} → ${b.to}`, risk: b.risk, reason: b.reason, outcomes: [] as string[] }));
  const fw = (from: string, to: string) => found.find((f) => f.leg === `${from} → ${to}` || f.leg === `${to} → ${from}`);
  for (const r of x.okRuns) {
    for (const l of r.legs) if (l.blocked && l.rerouted) fw(l.from, l.to)?.outcomes.push(`run ${r.label} (${r.carrier.name}): ${l.reasons[0]?.replace(/^direct road flooded \([^)]*\); /, "") ?? "alternative road"}`);
    for (const l of r.legs) if (l.blocked && !l.rerouted && l.risk === "medium") fw(l.from, l.to)?.outcomes.push(`run ${r.label} (${r.carrier.name}) drives it with care, flood risk medium`);
    for (const d of r.dropped) {
      const m = /^(.+?) → (.+?) road/.exec(d.why);
      (m ? fw(m[1], m[2]) : null)?.outcomes.push(`run ${r.label} (${r.carrier.name}) skips ${d.name}: its ${d.orderIds.length} order${d.orderIds.length === 1 ? "" : "s"} go ${describe(d.singles)}`);
      for (const s of d.singles) {
        const f = s.blocked ? fw(s.blocked.from, s.blocked.to) : null;
        const line = `${name(orders.find((o) => o.id === s.orderId)?.to_village_id ?? d.villageId)}: ${s.status === "rerouted" ? `${s.carrier.name} (${s.carrier.kind === "boat" ? "crosses where the road cannot" : s.carrier.kind === "motorbike" ? "the tracks around the water" : s.carrier.kind === "drone" ? "flies over it, proposed partner" : "alternative road"})` : s.floodRisk === "high" ? `${s.carrier.name} waits for the water to drop (${s.weightKg} kg, road vehicle only)` : `${s.carrier.name} on the direct road`}`;
        (f ?? found[0])?.outcomes.push(line);
      }
    }
  }
  for (const f of found) f.outcomes = [...new Set(f.outcomes)];
  const items = orders.reduce((s, o) => s + o.qty, 0);
  const kg = r1(orders.reduce((s, o) => s + (ITEM_KG[o.item] ?? 0.05) * o.qty, 0));
  const shipmentsByTier: Record<string, number> = {};
  for (const sh of x.plan.shipments) shipmentsByTier[sh.priority] = (shipmentsByTier[sh.priority] ?? 0) + 1;
  return {
    level: x.level,
    postsHit: Number(x.crisisRow.posts_hit),
    redVisits: Number(x.crisisRow.red_visits),
    yellowVisits: Number(x.crisisRow.yellow_visits),
    shelvesEmptied: Number(x.crisisRow.stock_outs),
    blocks: x.blocks.length,
    carriersDown: carriers.filter((c) => c.status === "down").length,
    postsInNeed: new Set(orders.map((o) => o.to_village_id)).size,
    orders: orders.length,
    patientOrders: orders.filter((o) => o.kind === "patient").length,
    restockOrders: orders.filter((o) => o.kind === "restock").length,
    items,
    kg,
    shipments: x.plan.shipments.length,
    shipmentsByTier,
    runs: runLabels.size,
    trips: tripList.length,
    carriersUsed: carriersUsed.size,
    carriersByKind,
    kmTotal,
    minutesTotal,
    naiveTrips,
    naiveKm,
    naiveMinutes,
    kmSaved: r1(naiveKm - kmTotal),
    minutesSaved: Math.round(naiveMinutes - minutesTotal),
    legsRerouted: x.okRuns.reduce((n, r) => n + r.legs.filter((l) => l.rerouted).length, 0),
    tripsRerouted: tripList.filter((t) => t.status === "rerouted" || /^rerouted/i.test(t.reason)).length,
    recheck: { checked: x.recheck.checked, rerouted: x.recheck.rerouted.length, changed: x.recheck.changed.length },
    unreachable,
    lent: [...lentMap.values()].sort((a, b) => b.qty - a.qty),
    found,
    notes: x.plan.notes.slice(0, 12),
    delivered: orders.filter((o) => o.status === "delivered").length,
    totalMs: Date.now() - x.t0,
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function describe(list: PlanResult[]) {
  const by = new Map<string, number>();
  for (const r of list) {
    const key = r.status === "rerouted" ? `by ${r.carrier.kind}` : r.floodRisk === "high" ? `waits for the water (${r.carrier.kind})` : `by ${r.carrier.kind} on the direct road`;
    by.set(key, (by.get(key) ?? 0) + 1);
  }
  return [...by].map(([k, n]) => `${k} ×${n}`).join(", ");
}

// For GET /api/crisis/status: the blocked legs with their road geometry (from the route cache), so
// the Crisis page can draw them in red.
export async function blockedLegs() {
  const blocks = await roadBlocks();
  return Promise.all(blocks.map(async (b) => {
    let points: LatLng[] = [b.fromAt, b.toAt];
    let km = r1(haversineKm(b.fromAt, b.toAt) * 1.5);
    try {
      const road = await roadPath(b.fromAt, b.toAt);
      points = road.main.points;
      km = road.main.km;
    } catch {
      // straight line between the two posts
    }
    return { id: b.id, from: b.from, to: b.to, fromVillageId: b.fromVillageId, toVillageId: b.toVillageId, risk: b.risk, reason: b.reason, until: b.until, km, points };
  }));
}
