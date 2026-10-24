import { NextResponse } from "next/server";
import { loadWorld } from "@/lib/routes/planner";
import { forcedFloods } from "@/lib/routes/flood";
import { cachedRouteCount, routerSource } from "@/lib/routes/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every planned route with its carrier and order, plus what the planner is running on
// (Google Maps or OSRM, how many road pairs are cached, which roads are flooded by the test switch).
export async function GET() {
  const { villages, carriers, orders, plans } = await loadWorld();
  const vmap = new Map(villages.map((v) => [v.id, v]));
  const cmap = new Map(carriers.map((c) => [c.id, c]));
  const omap = new Map(orders.map((o) => [o.id, o]));
  const name = (id: number) => vmap.get(id)?.name.replace(/ \(.*\)$/, "") ?? `#${id}`;
  return NextResponse.json({
    router: routerSource(),
    cachedPairs: await cachedRouteCount(),
    floods: await forcedFloods(),
    carriers: carriers.map((c) => ({ ...c, base: name(c.base_village_id) })),
    plans: plans.map((p) => {
      const o = omap.get(p.order_id), c = cmap.get(p.carrier_id);
      return {
        ...p,
        waypoints: JSON.parse(p.waypoints || "[]"),
        carrier: c ? { id: c.id, name: c.name, kind: c.kind, operator: c.operator } : null,
        order: o ? { ...o, from: name(o.from_village_id), to: name(o.to_village_id) } : null,
      };
    }),
    unplanned: orders.filter((o) => o.status !== "delivered" && !plans.some((p) => p.order_id === o.id)).map((o) => ({ ...o, from: name(o.from_village_id), to: name(o.to_village_id) })),
  });
}
