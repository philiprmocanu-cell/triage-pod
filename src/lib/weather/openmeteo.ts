// Open-Meteo, free and keyless (https://open-meteo.com, non-commercial use, 10 000 calls a day).
//
// Two services:
//  - /v1/forecast: 16 days of daily rain, rain probability and temperature ahead, and the last
//    30 days behind from the same weather model's analysis (ECMWF IFS / GFS "best match", about
//    11 km). The past days are model analysis, not rain gauges, but they arrive the same day
//    where NASA POWER lags two days and its recent weeks are preliminary.
//  - flood-api: Copernicus GloFAS v4 river discharge (5 km grid), same numbers the Copernicus
//    Early Warning Data Store serves behind a login, here without one. One call gives a year of
//    history plus 16 days ahead, so "the river is forecast above last year's 95th percentile"
//    can be computed per cell.
//
// Several cells go in one request (comma-separated coordinates), so all 40 posts cost two calls.

export type ForecastDay = { date: string; mm: number; prob: number | null; tMaxC: number | null; tMinC: number | null };
export type CellForecast = {
  lat: number; lng: number;
  past: ForecastDay[]; // oldest first, ends yesterday (30 days)
  future: ForecastDay[]; // today first (16 days)
  modelRun: string; // date the forecast was issued (today, UTC)
};
export type CellRiver = {
  lat: number; lng: number;
  history: number[]; // daily m³/s, oldest first, up to yesterday
  future: number[]; // today first (16 days)
  dates: { first: string; today: string; last: string };
};

const PAST_DAYS = 30, FORECAST_DAYS = 16, BATCH = 25, TIMEOUT = 15000;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

type Daily = { time: string[]; precipitation_sum: (number | null)[]; precipitation_probability_max?: (number | null)[]; temperature_2m_max?: (number | null)[]; temperature_2m_min?: (number | null)[] };

export async function fetchForecast(cells: { lat: number; lng: number }[]): Promise<CellForecast[]> {
  const out: CellForecast[] = [];
  for (const batch of chunks(cells, BATCH)) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${batch.map((c) => c.lat).join(",")}&longitude=${batch.map((c) => c.lng).join(",")}&daily=precipitation_sum,precipitation_probability_max,temperature_2m_max,temperature_2m_min&past_days=${PAST_DAYS}&forecast_days=${FORECAST_DAYS}&timezone=UTC`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`Open-Meteo forecast ${res.status}`);
    const json = (await res.json()) as { daily: Daily } | { daily: Daily }[];
    const list = Array.isArray(json) ? json : [json];
    list.forEach((r, i) => {
      const d = r.daily;
      const days: ForecastDay[] = d.time.map((date, k) => ({ date, mm: num(d.precipitation_sum[k]) ?? 0, prob: num(d.precipitation_probability_max?.[k]), tMaxC: num(d.temperature_2m_max?.[k]), tMinC: num(d.temperature_2m_min?.[k]) }));
      out.push({ lat: batch[i].lat, lng: batch[i].lng, past: days.slice(0, PAST_DAYS), future: days.slice(PAST_DAYS), modelRun: days[PAST_DAYS]?.date ?? days[0]?.date ?? "" });
    });
  }
  return out;
}

export async function fetchRiver(cells: { lat: number; lng: number }[], today: Date): Promise<CellRiver[]> {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const start = new Date(today); start.setUTCDate(start.getUTCDate() - 365);
  const end = new Date(today); end.setUTCDate(end.getUTCDate() + FORECAST_DAYS - 1);
  const out: CellRiver[] = [];
  for (const batch of chunks(cells, BATCH)) {
    const url = `https://flood-api.open-meteo.com/v1/flood?latitude=${batch.map((c) => c.lat).join(",")}&longitude=${batch.map((c) => c.lng).join(",")}&daily=river_discharge&start_date=${iso(start)}&end_date=${iso(end)}&models=seamless_v4`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`Open-Meteo flood ${res.status}`);
    const json = (await res.json()) as { daily: { time: string[]; river_discharge: (number | null)[] } } | { daily: { time: string[]; river_discharge: (number | null)[] } }[];
    const list = Array.isArray(json) ? json : [json];
    list.forEach((r, i) => {
      const t = r.daily.time, v = r.daily.river_discharge.map((x) => num(x) ?? 0);
      const k = Math.max(0, t.indexOf(iso(today)));
      out.push({ lat: batch[i].lat, lng: batch[i].lng, history: v.slice(0, k), future: v.slice(k), dates: { first: t[0], today: t[k], last: t[t.length - 1] } });
    });
  }
  return out;
}
