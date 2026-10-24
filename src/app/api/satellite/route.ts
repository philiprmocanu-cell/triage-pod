import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { POSTS } from "@/lib/network";

export const runtime = "nodejs";

// Satellite-derived weather over every health post, from NASA POWER (free, no key): the last 30
// days of rainfall (GPM IMERG) and air temperature (MERRA-2). Standing water after heavy rain plus
// warm nights is what drives malaria two to six weeks later; a very wet day cuts roads.
//
// The posts come from SpacetimeDB, the same 40 the map shows (the simulator's list is the fallback
// when the database is down). POWER's grid is 0.5° × 0.625°, so neighbouring posts share a cell
// and one request serves several of them. The last good answer is kept on disk, so the government
// view still has weather when the venue's internet is slow.
//
// Quality check: POWER's most recent weeks are PRELIMINARY (GPM "late run") and this season they
// read far wetter than the finished data for the same weeks a year earlier (hundreds of millimetres
// where last October's total was 0.3 mm). So every answer carries two things the page can show
// side by side: this window as NASA reports it today, and the same window one year ago from the
// finished record. Single day-values above SUSPECT_MM are left out of the totals and counted in
// the source line, so a risk flag never rests on one bad pixel.

type Day = { date: string; rainMm: number; tempC: number; suspect?: boolean };
type Site = { villageId: number; id: string; name: string; lat: number; lng: number; hub: boolean };
type CellWeather = { days: Day[]; rain30Mm: number; wettestDayMm: number; meanTempC: number; suspectDays: number; lastYearRain30Mm: number | null };
export type PostWeather = Site & CellWeather & { malariaRisk: "low" | "medium" | "high"; floodRisk: boolean };

const SUSPECT_MM = 150; // Zambia's wettest recorded days are around 200 mm; the grid average never gets near it
const SPACETIME_HTTP = process.env.SPACETIME_HTTP ?? "http://127.0.0.1:3000";
const SPACETIME_DB = process.env.SPACETIME_DB ?? "podnet";
const DISK = () => path.join(process.env.DATA_DIR ?? "data", "satellite.json");

let cache: { at: number; data: PostWeather[]; source: string } | null = null;

function ymd(d: Date) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
const short = (name: string) => name.replace(/ \(.*\)$/, "");
const slug = (name: string) => short(name).toLowerCase().replace(/[^a-z0-9]+/g, "-");

// The 40 sites from the live database; the simulator's list if it does not answer.
async function sites(): Promise<Site[]> {
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

// One POWER request per grid cell.
const cellOf = (lat: number, lng: number) => ({ lat: Math.round(lat / 0.5) * 0.5, lng: Math.round(lng / 0.625) * 0.625 });

async function fetchCell(lat: number, lng: number, start: string, end: string): Promise<CellWeather> {
  const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR,T2M&community=AG&longitude=${lng}&latitude=${lat}&start=${start}&end=${end}&format=JSON`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`NASA POWER ${res.status}`);
  const json = (await res.json()) as { properties: { parameter: { PRECTOTCORR: Record<string, number>; T2M: Record<string, number> } } };
  const rain = json.properties.parameter.PRECTOTCORR, temp = json.properties.parameter.T2M;
  const days: Day[] = Object.keys(rain)
    .sort()
    .filter((d) => rain[d] >= 0 && temp[d] > -900) // -999 = not yet processed
    .map((d) => ({ date: d, rainMm: rain[d], tempC: temp[d], suspect: rain[d] > SUSPECT_MM || undefined }));
  const good = days.filter((d) => !d.suspect);
  const rain30Mm = good.reduce((s, d) => s + d.rainMm, 0);
  const wettestDayMm = Math.max(0, ...good.map((d) => d.rainMm));
  const meanTempC = days.length ? days.reduce((s, d) => s + d.tempC, 0) / days.length : 0;
  return { days, rain30Mm: Math.round(rain30Mm), wettestDayMm: Math.round(wettestDayMm), meanTempC: Math.round(meanTempC * 10) / 10, suspectDays: days.length - good.length, lastYearRain30Mm: await fetchLastYear(lat, lng, start, end) };
}

// The same 30 days one year earlier, from the finished record: the yardstick for the preliminary numbers.
async function fetchLastYear(lat: number, lng: number, start: string, end: string): Promise<number | null> {
  const back = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
  try {
    const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR&community=AG&longitude=${lng}&latitude=${lat}&start=${back(start)}&end=${back(end)}&format=JSON`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { properties: { parameter: { PRECTOTCORR: Record<string, number> } } };
    const vals = Object.values(json.properties.parameter.PRECTOTCORR).filter((v) => v >= 0);
    return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0)) : null;
  } catch {
    return null;
  }
}

// Anopheles transmission window: enough rain for breeding sites and 18–32 °C.
function withRisk(site: Site, w: CellWeather): PostWeather {
  const warm = w.meanTempC >= 18 && w.meanTempC <= 32;
  // NASA's preliminary run can be wildly wet (hundreds of mm in the dry season). When it is out
  // of all proportion to the finished record for the same weeks last year, score the risk on
  // last year's rain instead, so the badge does not read "high" at all 40 posts for no reason.
  const implausible = w.lastYearRain30Mm !== null && w.rain30Mm > 5 * w.lastYearRain30Mm + 50;
  const rain = implausible ? w.lastYearRain30Mm! : w.rain30Mm;
  const malariaRisk = warm && rain >= 80 ? "high" : warm && rain >= 30 ? "medium" : "low";
  return { ...site, ...w, malariaRisk, floodRisk: !implausible && w.wettestDayMm >= 40 };
}

async function fromDisk(): Promise<{ at: number; data: PostWeather[]; source: string } | null> {
  try {
    const saved = JSON.parse(await fs.readFile(DISK(), "utf8")) as { at: number; data: PostWeather[]; source: string };
    return saved.data?.length ? saved : null;
  } catch {
    return null;
  }
}

export async function GET() {
  if (cache && Date.now() - cache.at < 6 * 3600_000) return NextResponse.json({ posts: cache.data, source: cache.source, cached: true, fetchedAt: new Date(cache.at).toISOString() });
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2); // POWER lags about two days
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  const list = await sites();
  const cells = new Map<string, { lat: number; lng: number }>();
  for (const s of list) {
    const c = cellOf(s.lat, s.lng);
    cells.set(`${c.lat}|${c.lng}`, c);
  }
  const results = await Promise.allSettled([...cells].map(async ([key, c]) => [key, await fetchCell(c.lat, c.lng, ymd(start), ymd(end))] as const));
  const byCell = new Map(results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
  const data = list.flatMap((s) => {
    const c = cellOf(s.lat, s.lng);
    const w = byCell.get(`${c.lat}|${c.lng}`);
    return w ? [withRisk(s, w)] : [];
  });
  if (!data.length) {
    const saved = cache ?? (await fromDisk());
    if (saved) return NextResponse.json({ posts: saved.data, source: `${saved.source} (saved copy; NASA POWER is unreachable right now)`, cached: true, fetchedAt: new Date(saved.at).toISOString() });
    return NextResponse.json({ error: "NASA POWER unreachable", posts: [], source: "" }, { status: 502 });
  }
  const failed = list.length - data.length;
  const suspect = data.reduce((n, p) => n + p.suspectDays, 0);
  const source =
    `NASA POWER (satellite-derived GPM rain, MERRA-2 temperature), ${ymd(start)}–${ymd(end)}, ${data.length} posts over ${byCell.size} grid cells. Recent weeks are NASA's preliminary run, shown next to the finished record for the same weeks last year` +
    (failed ? `; ${failed} posts unavailable` : "") +
    (suspect ? `; ${suspect} day-values above ${SUSPECT_MM} mm left out of the totals` : "") +
    ".";
  cache = { at: Date.now(), data, source };
  fs.mkdir(path.dirname(DISK()), { recursive: true })
    .then(() => fs.writeFile(DISK(), JSON.stringify(cache)))
    .catch(() => {});
  return NextResponse.json({ posts: data, source, cached: false, fetchedAt: new Date(cache.at).toISOString() });
}
