// Pure geometry over the settlement file — safe to import in the browser (no fs). The server
// side (load from disk) is in ./index.ts.
//
// public/settlements/eastern-province.json, from tools/settlements/fetch.py:
//   n  name (missing = unnamed hamlet)        la, ln  4-decimal coordinates
//   p  people (census when known, else houses × 4.5)
//   k  city | town | village | locality (missing = hamlet)
//   h  houses counted from satellite imagery (missing = gazetteer point only)

export type Settlement = { n?: string; la: number; ln: number; p: number; k?: string; h?: number };
export type SettlementSources = {
  osm: number; osmArea: string; geonames: number;
  openBuildings?: { clusters: number; named: number; unnamed: number; minHouses: number; cellM: number; roofs: number };
  gazetteerOnly?: number; peoplePerHouse?: number; polygon?: string;
};
export type SettlementFile = { sources: SettlementSources; fetched: string; points: Settlement[] };
export type Post = { id: number; name: string; lat: number; lng: number };
export type Served = { post: Post; km: number };

const R = 6371;
export function kmBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const p1 = (aLat * Math.PI) / 180, p2 = (bLat * Math.PI) / 180;
  const dp = p2 - p1, dl = ((bLng - aLng) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
}

export const kindOf = (s: Settlement) => s.k ?? "hamlet";
export const nameOf = (s: Settlement) => s.n ?? (s.h ? `hamlet, ${s.h} house${s.h === 1 ? "" : "s"}` : "unnamed place");

// Settlements within `km` of a point, nearest first. Linear scan: fine for a one-off query on the
// server; the globe uses SettlementIndex below for every mouse move.
export function nearest(points: Settlement[], lat: number, lng: number, km: number): (Settlement & { km: number })[] {
  const dlat = km / 111;
  const out: (Settlement & { km: number })[] = [];
  for (const s of points) {
    if (Math.abs(s.la - lat) > dlat) continue;
    const d = kmBetween(lat, lng, s.la, s.ln);
    if (d <= km) out.push({ ...s, km: d });
  }
  return out.sort((a, b) => a.km - b.km);
}

// The nearest of the 40 health posts (SpacetimeDB's village table) to a settlement.
export function servedBy(s: { la: number; ln: number }, posts: Post[]): Served | null {
  let best: Served | null = null;
  for (const post of posts) {
    const km = kmBetween(s.la, s.ln, post.lat, post.lng);
    if (!best || km < best.km) best = { post, km };
  }
  return best;
}

// Every settlement assigned to its nearest post, plus per-post totals ("serves N villages, ~P people").
export type Catchment = { count: number; people: number; named: number; houses: number };
export function catchments(points: Settlement[], posts: Post[]): { assign: Int32Array; byPost: Map<number, Catchment> } {
  const assign = new Int32Array(points.length);
  const byPost = new Map<number, Catchment>();
  for (const post of posts) byPost.set(post.id, { count: 0, people: 0, named: 0, houses: 0 });
  points.forEach((s, i) => {
    const hit = servedBy(s, posts);
    assign[i] = hit ? hit.post.id : -1;
    if (!hit) return;
    const c = byPost.get(hit.post.id)!;
    c.count++;
    c.people += s.p;
    if (s.n) c.named++;
    c.houses += s.h ?? 0;
  });
  return { assign, byPost };
}

// Grid index for "what is under the mouse": cells of ~2 km, lookups by radius in km.
export class SettlementIndex {
  private cells = new Map<number, number[]>();
  private readonly cell = 0.02; // degrees
  constructor(public points: Settlement[]) {
    points.forEach((s, i) => {
      const k = this.key(s.la, s.ln);
      const list = this.cells.get(k);
      if (list) list.push(i);
      else this.cells.set(k, [i]);
    });
  }
  private key(lat: number, lng: number) {
    return Math.floor((lat + 90) / this.cell) * 100000 + Math.floor((lng + 180) / this.cell);
  }
  // Nearest settlement within `km`; `weight` lets bigger places win a tie under the cursor.
  nearest(lat: number, lng: number, km: number, weight = false): (Settlement & { km: number; i: number }) | null {
    const r = Math.ceil(km / 111 / this.cell);
    const cy = Math.floor((lat + 90) / this.cell), cx = Math.floor((lng + 180) / this.cell);
    let best: (Settlement & { km: number; i: number }) | null = null, bestScore = Infinity;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const list = this.cells.get((cy + dy) * 100000 + (cx + dx));
        if (!list) continue;
        for (const i of list) {
          const s = this.points[i];
          const d = kmBetween(lat, lng, s.la, s.ln);
          if (d > km) continue;
          const score = weight ? d / (1 + Math.log10(1 + (s.h ?? 5))) : d;
          if (score < bestScore) {
            bestScore = score;
            best = { ...s, km: d, i };
          }
        }
      }
    return best;
  }
}

export const fmtPeople = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
export const earthUrl = (lat: number, lng: number) => `https://earth.google.com/web/@${lat.toFixed(5)},${lng.toFixed(5)},500a,2000d,35y,0h,0t,0r`;
export const mapsSatelliteUrl = (lat: number, lng: number) => `https://www.google.com/maps/@${lat.toFixed(5)},${lng.toFixed(5)},1500m/data=!3m1!1e3`;
