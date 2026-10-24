import { NextResponse } from "next/server";
import { getWeather, roadRisk } from "@/lib/weather";

export const runtime = "nodejs";

// Risk for one road leg, for the Routes agent:
//   GET /api/weather/road?from=<lat>,<lng>&to=<lat>,<lng>[&date=YYYY-MM-DD][&days=3]
//   → { risk: "low"|"medium"|"high", reasons: string[], distanceKm, date, days, samples[], sources[], preliminary, fetchedAt }
// `date` is the day the truck leaves (default today), `days` how many days the trip and its
// return are exposed (default 3, max 16). 3–5 points along the straight line are read against
// the cached forecast cells and the flood map, so a call costs a few milliseconds once the
// three-hourly cache is warm. The leg carries its worst sample. See docs/WEATHER.md.

function parse(v: string | null): { lat: number; lng: number } | null {
  const m = v?.split(",").map((x) => Number(x.trim()));
  if (!m || m.length !== 2 || m.some((x) => !Number.isFinite(x))) return null;
  const [lat, lng] = m;
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const from = parse(url.searchParams.get("from")), to = parse(url.searchParams.get("to"));
  if (!from || !to) return NextResponse.json({ error: "from and to must be <lat>,<lng>", example: "/api/weather/road?from=-13.633,32.65&to=-14.05,32.05" }, { status: 400 });
  const days = Number(url.searchParams.get("days") ?? 3);
  const date = url.searchParams.get("date") ?? undefined;
  try {
    const w = await getWeather();
    return NextResponse.json(roadRisk(from, to, w, { date, days: Number.isFinite(days) ? days : 3 }));
  } catch (e) {
    return NextResponse.json({ risk: "low", reasons: [`weather unavailable: ${e instanceof Error ? e.message : String(e)}`], from, to, samples: [], sources: [], preliminary: "" }, { status: 502 });
  }
}
