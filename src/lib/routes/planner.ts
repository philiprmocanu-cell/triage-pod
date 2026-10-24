import { logAgent, planRoute, sqlRows } from "@/lib/spacetime";
import { floodRisk, type FloodCheck, type FloodRisk } from "./flood";
import { haversineKm, minutesFor, roadPath, thin, type LatLng, type RoadPath } from "./router";

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

type Village = { id: number; name: string; lat: number; lng: number; population: number; hub: boolean };
type Carrier = { id: number; name: string; kind: string; operator: string; base_village_id: number; capacity_kg: number; speed_kmh: number; cost_per_km: number; status: string };
type Order = { id: number; kind: string; patient_name: string; to_village_id: number; from_village_id: number; item: string; qty: number; mode: string; status: string };
type Plan = { id: number; order_id: number; carrier_id: number; waypoints: string; km: number; minutes: number; flood_risk: string; status: string; reason: string };

const HEAVY = new Set(["Oxygen cylinder", "IV fluids"]); // keep identical to the module
// Rough kg per unit, so a carrier's capacity means something.
const WEIGHT_KG: Record<string, number> = {
  "Oxygen cylinder": 15, "IV fluids": 1.2, "Blood (O negative)": 0.6, "Therapeutic food (RUTF)": 0.1, "Splint": 0.5, "Wound dressing kit": 0.4, "Salbutamol inhaler": 0.05,
};
const ROAD_KINDS = new Set(["truck", "pickup"]);
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
};

export async function loadWorld() {
  const [villages, carriers, orders, plans] = await Promise.all([
    sqlRows<Village>("SELECT * FROM village"),
    sqlRows<Carrier>("SELECT * FROM carrier"),
    sqlRows<Order>("SELECT id, kind, patient_name, to_village_id, from_village_id, item, qty, mode, status FROM delivery_order"),
    sqlRows<Plan>("SELECT id, order_id, carrier_id, waypoints, km, minutes, flood_risk, status, reason FROM route_plan"),
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

export async function planOrder(orderId: number, origin: string, opts: { quiet?: boolean } = {}): Promise<PlanResult> {
  const { villages, carriers, orders, plans } = await loadWorld();
  const order = orders.find((o) => o.id === orderId);
  if (!order) throw new Error(`No order ${orderId}`);
  const own = plans.find((p) => p.order_id === orderId)?.carrier_id ?? 0; // re-planning: its own carrier is not "busy"
  const vmap = new Map(villages.map((v) => [v.id, v]));
  const from = vmap.get(order.from_village_id), to = vmap.get(order.to_village_id);
  if (!from || !to) throw new Error(`Order ${orderId} has an unknown village`);
  const kg = weightKg(order.item, order.qty);
  const heavy = HEAVY.has(order.item);
  const what = `${order.qty} ${order.item} (${kg} kg)`;

  // Same village: someone walks or cycles it across.
  if (from.id === to.id) {
    const pick = pickCarrier(carriers, vmap, from, to, kg, ["bicycle", "motorbike", "pickup"], 2, own);
    const chosen = pick?.c ?? carriers.find((c) => c.kind === "pickup") ?? carriers[0];
    const minutes = minutesFor(2, chosen.speed_kmh);
    const reason = `Within ${short(to.name)}: ${chosen.name} takes it across the village from the health post.`;
    await planRoute({ orderId, carrierId: chosen.id, waypoints: [at(from), at(to)], km: 2, minutes, floodRisk: "low", reason });
    if (!opts.quiet) await logAgent("Route planner", to.name, `${short(to.name)}: ${what} for ${order.patient_name} → ${chosen.name}, in the village, ~${minutes} min.`);
    return { orderId, carrier: pickFields(chosen), km: 2, minutes, floodRisk: "low", status: "planned", reason, source: "straight", flood: { risk: "low", reasons: [], stubbed: false, forced: false }, weightKg: kg };
  }

  const road = await roadPath(at(from), at(to));
  const flood = await floodRisk(at(from), at(to), origin);
  const why = (f: FloodCheck) => f.reasons.slice(0, 2).map((r) => (r.length > 110 ? r.slice(0, 107) + "…" : r)).join("; ");
  const kinds = heavy ? ["truck", "pickup"] : ["pickup", "motorbike", "truck", "bicycle"];
  let pick = pickCarrier(carriers, vmap, from, to, kg, kinds, road.main.km, own);
  let path: RoadPath = road.main;
  let status: "planned" | "rerouted" = "planned";
  let risk: FloodRisk = flood.risk;
  let reason = "";
  const sourceNote = road.main.source === "google" ? "Google Maps road" : road.main.source === "osrm" ? "OpenStreetMap road (OSRM)" : "straight line ×1.5 (no router reachable)";

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
        ...(carriers.some((c) => c.kind === "boat" && (c.base_village_id === from.id || c.base_village_id === to.id)) ? ["boat"] : []),
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
    const any = carriers.filter((c) => c.capacity_kg >= kg).sort((a, b) => b.capacity_kg - a.capacity_kg)[0] ?? carriers[0];
    pick = { c: any, deadheadKm: 0, minutes: minutesFor(path.km, any.speed_kmh), cost: 0 };
  }
  const chosen = pick.c;
  const points = chosen.kind === "drone" ? [at(from), at(to)] : thin(path.points);
  const km = chosen.kind === "drone" ? Math.round(haversineKm(at(from), at(to)) * 10) / 10 : path.km;
  const minutes = minutesFor(km, chosen.speed_kmh);
  if (!reason) {
    reason = `${chosen.name} (${chosen.operator}): ${heavy ? "heavy item, road vehicle only" : `quickest idle carrier for ${kg} kg`}${pick.deadheadKm ? `, ${pick.deadheadKm} km from its base in ${short(vmap.get(chosen.base_village_id)?.name ?? "")}` : ", already at the pickup"}. ${sourceNote}${path.summary ? ` via ${path.summary}` : ""}, ${km} km, ~${minutes} min.${flood.risk === "medium" ? ` Flood risk medium: ${why(flood)}.` : flood.risk === "low" && !flood.stubbed && flood.reasons[0] ? ` Weather: ${flood.reasons[0].slice(0, 110)}.` : ""}${flood.stubbed ? ` (${flood.reasons.find((r) => r.includes("weather check")) ?? "weather check stubbed"})` : ""}`;
  }
  await planRoute({ orderId, carrierId: chosen.id, waypoints: points, km, minutes, floodRisk: risk, reason });
  if (!opts.quiet) {
    await logAgent(
      "Route planner",
      to.name,
      `${short(from.name)} → ${short(to.name)}: ${what} for ${order.kind === "restock" ? `${short(to.name)} post` : order.patient_name} by ${chosen.name}, ${km} km on ${chosen.kind === "drone" ? "a straight flight" : sourceNote}, ~${minutes} min, flood risk ${risk}${status === "rerouted" ? " → RE-ROUTED" : ""}.`
    );
  }
  return { orderId, carrier: pickFields(chosen), km, minutes, floodRisk: risk, status, reason, source: path.source, flood, weightKg: kg };
}

const pickFields = (c: Carrier) => ({ id: c.id, name: c.name, kind: c.kind, operator: c.operator });

// Every open order that has no plan yet (or whose plan is older than a re-flood), one by one.
export async function planAllOpen(origin: string, opts: { replan?: boolean } = {}) {
  const { orders, plans } = await loadWorld();
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
