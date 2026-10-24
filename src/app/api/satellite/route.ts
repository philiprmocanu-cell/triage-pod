import { NextResponse } from "next/server";
import { POSTS } from "@/lib/network";

export const runtime = "nodejs";

// Satellite-derived weather for every post, from NASA POWER (MERRA-2 / GPM satellite products,
// free, no key): the last 30 days of rainfall and temperature. Standing water after heavy rain
// plus warm nights is what drives malaria two to six weeks later; a very wet day floods roads.
// The outbreak sentinel and the supply allocator read this as a prior; the government view shows it.

type Day = { date: string; rainMm: number; tempC: number };
type PostWeather = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  rain30Mm: number;
  wettestDayMm: number;
  meanTempC: number;
  malariaRisk: "low" | "medium" | "high";
  floodRisk: boolean;
  days: Day[];
};

let cache: { at: number; data: PostWeather[]; source: string } | null = null;

function ymd(d: Date) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function fetchPost(p: (typeof POSTS)[number], start: string, end: string): Promise<PostWeather> {
  const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR,T2M&community=AG&longitude=${p.lng}&latitude=${p.lat}&start=${start}&end=${end}&format=JSON`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`NASA POWER ${res.status}`);
  const json = (await res.json()) as { properties: { parameter: { PRECTOTCORR: Record<string, number>; T2M: Record<string, number> } } };
  const rain = json.properties.parameter.PRECTOTCORR, temp = json.properties.parameter.T2M;
  const days: Day[] = Object.keys(rain)
    .sort()
    .filter((d) => rain[d] >= 0) // -999 = not yet processed
    .map((d) => ({ date: d, rainMm: rain[d], tempC: temp[d] }));
  const rain30Mm = days.reduce((s, d) => s + d.rainMm, 0);
  const wettestDayMm = Math.max(0, ...days.map((d) => d.rainMm));
  const meanTempC = days.length ? days.reduce((s, d) => s + d.tempC, 0) / days.length : 0;
  // Anopheles transmission window: enough rain for breeding sites and 18–32 °C.
  const warm = meanTempC >= 18 && meanTempC <= 32;
  const malariaRisk = warm && rain30Mm >= 80 ? "high" : warm && rain30Mm >= 30 ? "medium" : "low";
  return { id: p.id, name: p.name, lat: p.lat, lng: p.lng, rain30Mm: Math.round(rain30Mm), wettestDayMm: Math.round(wettestDayMm), meanTempC: Math.round(meanTempC * 10) / 10, malariaRisk, floodRisk: wettestDayMm >= 40, days };
}

export async function GET() {
  if (cache && Date.now() - cache.at < 6 * 3600_000) return NextResponse.json({ posts: cache.data, source: cache.source, cached: true });
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2); // POWER lags about two days
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  const results = await Promise.allSettled(POSTS.map((p) => fetchPost(p, ymd(start), ymd(end))));
  const data = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failed = results.filter((r) => r.status === "rejected").length;
  if (!data.length) return NextResponse.json({ error: "NASA POWER unreachable", posts: cache?.data ?? [], source: cache?.source ?? "" }, { status: cache ? 200 : 502 });
  const source = `NASA POWER (satellite-derived MERRA-2/GPM), ${ymd(start)}–${ymd(end)}${failed ? `, ${failed} posts unavailable` : ""}`;
  cache = { at: Date.now(), data, source };
  return NextResponse.json({ posts: data, source, cached: false });
}
