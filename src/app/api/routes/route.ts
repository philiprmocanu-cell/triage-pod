import { NextResponse } from "next/server";
import { getLastRecheck, loadWorld } from "@/lib/routes/planner";
import { forcedFloods } from "@/lib/routes/flood";
import { cachedRouteCount, pairKey, routerSource, type LatLng } from "@/lib/routes/router";
import { allSurfaces, describeSurface, sumSurfaces, type RoadSurface } from "@/lib/routes/surface";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RUN_RE = /run ([A-Z0-9]+) stop (\d+) of (\d+) \(([^)]+)\)/;

// Every planned route with its carrier and order, plus what the planner is running on
// (Google Maps or OSRM, how many road pairs are cached, which roads are flooded by the test
// switch), the road surface of each plan from OpenStreetMap, and the watcher's last re-check.
export async function GET() {
  const [{ villages, carriers, orders, plans }, surfaces] = await Promise.all([loadWorld(), allSurfaces()]);
  const vmap = new Map(villages.map((v) => [v.id, v]));
  const cmap = new Map(carriers.map((c) => [c.id, c]));
  const omap = new Map(orders.map((o) => [o.id, o]));
  const byShort = new Map(villages.map((v) => [v.name.replace(/ \(.*\)$/, "").toLowerCase(), v]));
  const name = (id: number) => vmap.get(id)?.name.replace(/ \(.*\)$/, "") ?? `#${id}`;
  const at = (id: number): LatLng | null => { const v = vmap.get(id); return v ? [v.lat, v.lng] : null; };
  const pairSurface = (a: LatLng | null, b: LatLng | null) => (a && b ? surfaces[pairKey(a, b)] ?? surfaces[pairKey(b, a)] ?? null : null);
  // A run's surface is the sum of its legs (the tour is written in the reason).
  const surfaceOf = (p: (typeof plans)[number]): RoadSurface | null => {
    const o = omap.get(p.order_id);
    if (!o) return null;
    const m = RUN_RE.exec(p.reason);
    if (m) {
      const tour = m[4].split("→").map((s) => byShort.get(s.trim().toLowerCase())).filter((v): v is NonNullable<typeof v> => !!v);
      if (tour.length >= 2) return sumSurfaces(tour.slice(1).map((v, i) => pairSurface([tour[i].lat, tour[i].lng], [v.lat, v.lng])));
    }
    return pairSurface(at(o.from_village_id), at(o.to_village_id));
  };
  const withText = (s: RoadSurface | null) => (s ? { ...s, text: describeSurface(s) } : null);
  return NextResponse.json({
    router: routerSource(),
    googleKey: !!process.env.GOOGLE_MAPS_API_KEY,
    cachedPairs: await cachedRouteCount(),
    surfacedPairs: Object.keys(surfaces).length,
    floods: await forcedFloods(),
    lastRecheck: getLastRecheck(),
    carriers: carriers.map((c) => ({ ...c, base: name(c.base_village_id) })),
    plans: plans.map((p) => {
      const o = omap.get(p.order_id), c = cmap.get(p.carrier_id);
      const m = RUN_RE.exec(p.reason);
      return {
        ...p,
        waypoints: JSON.parse(p.waypoints || "[]"),
        carrier: c ? { id: c.id, name: c.name, kind: c.kind, operator: c.operator } : null,
        order: o ? { ...o, from: name(o.from_village_id), to: name(o.to_village_id) } : null,
        surface: withText(surfaceOf(p)),
        run: m ? { id: m[1], stop: Number(m[2]), of: Number(m[3]), tour: m[4] } : null,
      };
    }),
    unplanned: orders.filter((o) => o.status !== "delivered" && !plans.some((p) => p.order_id === o.id)).map((o) => ({ ...o, from: name(o.from_village_id), to: name(o.to_village_id) })),
  });
}
