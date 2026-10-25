import { NextResponse } from "next/server";
import { cachedPairs, type LatLng } from "@/lib/routes/router";
import { allSurfaces, describeSurface, roadSurface } from "@/lib/routes/surface";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Road surface from OpenStreetMap (paved / gravel / dirt-track km) for the cached roads.
//   GET  /api/routes/surface                      every measured pair
//   POST /api/routes/surface { all: true }        measure every road in data/routes.json (minutes)
//   POST /api/routes/surface { from: [lat,lng], to: [lat,lng] }   one road, measured now
export async function GET() {
  const all = await allSurfaces();
  return NextResponse.json({ pairs: Object.keys(all).length, surfaces: Object.fromEntries(Object.entries(all).map(([k, s]) => [k, { ...s, text: describeSurface(s) }])) });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { all?: boolean; from?: LatLng; to?: LatLng; refresh?: boolean };
  try {
    if (body.all) {
      const pairs = await cachedPairs();
      let measured = 0, failed = 0, cached = 0;
      const before = await allSurfaces();
      for (const [a, b] of pairs) {
        try {
          const had = !!before[`${a[0].toFixed(4)},${a[1].toFixed(4)}|${b[0].toFixed(4)},${b[1].toFixed(4)}`];
          const s = await roadSurface(a, b, { refresh: body.refresh });
          if (!s) failed++;
          else if (had && !body.refresh) cached++;
          else measured++;
        } catch {
          failed++;
        }
      }
      return NextResponse.json({ pairs: pairs.length, measured, cached, failed });
    }
    if (!body.from || !body.to) return NextResponse.json({ error: "from and to as [lat, lng], or { all: true }" }, { status: 400 });
    const s = await roadSurface(body.from, body.to, { refresh: body.refresh });
    return NextResponse.json(s ? { ...s, text: describeSurface(s) } : { error: "no road between these points" }, { status: s ? 200 : 404 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
