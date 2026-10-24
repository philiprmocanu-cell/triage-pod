import { POSTS } from "@/lib/network";

// The 40 health posts, from the live SpacetimeDB village table (the simulator's list when the
// database is down). Shared by /api/satellite and /api/weather so both talk about the same sites.

export type Site = { villageId: number; id: string; name: string; lat: number; lng: number; hub: boolean };

const SPACETIME_HTTP = process.env.SPACETIME_HTTP ?? "http://127.0.0.1:3000";
const SPACETIME_DB = process.env.SPACETIME_DB ?? "podnet";

const short = (name: string) => name.replace(/ \(.*\)$/, "");
const slug = (name: string) => short(name).toLowerCase().replace(/[^a-z0-9]+/g, "-");

export async function sites(): Promise<Site[]> {
  try {
    const res = await fetch(`${SPACETIME_HTTP}/v1/database/${SPACETIME_DB}/sql`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "SELECT * FROM village", signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(`SpacetimeDB ${res.status}`);
    const [table] = (await res.json()) as { schema: { elements: { name: { some: string } }[] }; rows: unknown[][] }[];
    const col = table.schema.elements.map((e) => e.name.some);
    const rows = table.rows.map((r) => Object.fromEntries(r.map((v, i) => [col[i], v])) as { id: number; name: string; lat: number; lng: number; hub: boolean });
    if (rows.length) return rows.map((v) => ({ villageId: v.id, id: slug(v.name), name: v.name, lat: v.lat, lng: v.lng, hub: v.hub }));
  } catch {
    // fall through to the simulator's list
  }
  return POSTS.map((p, i) => ({ villageId: i + 1, id: p.id, name: p.name, lat: p.lat, lng: p.lng, hub: !!p.hub }));
}
