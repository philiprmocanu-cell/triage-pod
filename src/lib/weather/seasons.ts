import { promises as fs } from "fs";
import path from "path";
import { sites, type Site } from "./sites";
import { cellOf, cellKey } from "./index";
import { DAY_CUT_MM, THREE_DAY_CUT_MM } from "./model";

// The seasonal calendar: when the rains usually start and stop at each post, which weeks usually
// bring road-closing rain, how many days a month the post is usually cut off, and when malaria
// peaks (4–8 weeks after the rain). Ten hydrological years (1 July → 30 June) of daily rain from
// the Open-Meteo archive API (ERA5 reanalysis, free, keyless), one 0.25° cell per post, computed
// once and kept in data/seasons.json for a month.
//
// Honest limit: ERA5 is an area average over a ~28 km cell, so its daily extremes are softer than
// what a gauge on one road records. Before the closure thresholds from model.ts are applied, the
// cell average is scaled by AREA_TO_POINT (1.5); that factor is an estimate, named here so the
// district can tune it against its own record of which roads closed when.

export const AREA_TO_POINT = 1.5;
export const YEARS = 10;
export const CLOSURE_WEEK_MIN_FREQ = 0.3; // a week counts as a closure week when 3 of 10 years closed the road in it
export const CLOSURE_LASTS_DAYS = 3; // a closing day plus the days the water takes to drop
const ONSET_10D_MM = 25, ONSET_DRY_SPELL_DAYS = 10, CESSATION_10D_MM = 20;
const TTL_MS = 30 * 86400_000;
const TIMEOUT = 60_000;
const BATCH = 4, BATCH_GAP_MS = 2500;
const DISK = () => path.join(process.env.DATA_DIR ?? "data", "seasons.json");

export type ClosureWeek = { from: string; to: string; yearsOutOf: number; frequency: number };
export type CellSeason = {
  cell: string;
  lat: number;
  lng: number;
  years: number;
  typical: { start: string; end: string }; // "MM-DD"
  onsetSpreadDays: number; // standard deviation of the onset across years
  seasonRainMm: number; // mean July–June total
  rainByMonth: number[]; // mean mm, index 0 = January
  cutOffDaysByMonth: number[]; // mean days the road is cut, index 0 = January
  closureWeekFreq: number[]; // 53 season weeks from 1 July: share of years with a closing day in that week
  rainPeakWeek: number; // season week (from 1 July) starting the wettest 4 weeks
  wettestDayMm: number; // the wettest ERA5 day in the record, cell average
  closingDays: number; // days in the record that reached the (scaled) closure mark
};
export type PostSeason = Site & {
  cell: string;
  wetSeasonStart: string; // ISO date in the current or coming season
  wetSeasonEnd: string;
  typical: { start: string; end: string };
  closureWeeks: ClosureWeek[];
  closureStart: string | null; // first closure week's first day, this season
  closureEnd: string | null;
  cutOffDaysByMonth: number[];
  cutOffDaysInSeason: number; // sum over the closure window
  malariaPeak: { from: string; to: string };
  confidence: "high" | "medium" | "low";
  confidenceWhy: string;
  seasonRainMm: number;
  rainByMonth: number[];
  years: number;
  source: string;
};

type Store = { range: { start: string; end: string }; fetchedAt: number; cells: Record<string, CellSeason>; errors?: string };
let store: Store | null = null;
let inflight: Promise<Store> | null = null;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (isoDate: string, n: number) => { const d = new Date(`${isoDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const r1 = (x: number) => Math.round(x * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const stddev = (xs: number[]) => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };

// Ten full hydrological years ending last 30 June.
export function archiveRange(today = new Date()) {
  const y = today.getUTCFullYear();
  const lastJune = today.getUTCMonth() >= 6 ? y : y - 1; // month index 6 = July
  return { start: `${lastJune - YEARS}-07-01`, end: `${lastJune}-06-30` };
}

// The season we are in or about to enter: starts 1 July of this year if we are past June.
export function seasonStartFor(today = new Date()) {
  const y = today.getUTCFullYear();
  return `${today.getUTCMonth() >= 6 ? y : y - 1}-07-01`;
}

async function fromDisk(): Promise<Store | null> {
  try {
    const s = JSON.parse(await fs.readFile(DISK(), "utf8")) as Store;
    return s && s.cells ? s : null;
  } catch {
    return null;
  }
}

async function toDisk(s: Store) {
  await fs.mkdir(path.dirname(DISK()), { recursive: true });
  await fs.writeFile(DISK(), JSON.stringify(s));
}

type Daily = { time: string[]; precipitation_sum: (number | null)[] };

// Ten years of daily rain is a heavy request for the free archive (its minutely quota weighs
// requests by days × locations), so cells go a few at a time with a pause, and a 429 waits a
// minute and tries once more. `onBatch` lets the caller keep what has arrived if a later batch fails.
async function fetchArchive(cells: { lat: number; lng: number }[], range: { start: string; end: string }, onBatch?: (rows: { lat: number; lng: number; time: string[]; mm: number[] }[]) => void) {
  const out: { lat: number; lng: number; time: string[]; mm: number[] }[] = [];
  for (let i = 0; i < cells.length; i += BATCH) {
    const batch = cells.slice(i, i + BATCH);
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${batch.map((c) => c.lat).join(",")}&longitude=${batch.map((c) => c.lng).join(",")}&start_date=${range.start}&end_date=${range.end}&daily=precipitation_sum&timezone=UTC`;
    let res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 61_000));
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    }
    if (!res.ok) throw new Error(`Open-Meteo archive ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const json = (await res.json()) as { daily: Daily } | { daily: Daily }[];
    const list = Array.isArray(json) ? json : [json];
    const rows = list.map((r, k) => ({ lat: batch[k].lat, lng: batch[k].lng, time: r.daily.time, mm: r.daily.precipitation_sum.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0)) }));
    out.push(...rows);
    onBatch?.(rows);
    if (i + BATCH < cells.length) await new Promise((r) => setTimeout(r, BATCH_GAP_MS));
  }
  return out;
}

// Everything about one cell's seasons, from its daily record.
export function computeCellSeason(cell: { lat: number; lng: number }, time: string[], mm: number[]): CellSeason {
  const n = time.length;
  const closing = new Array<boolean>(n).fill(false);
  let closingDays = 0, wettest = 0;
  for (let i = 0; i < n; i++) {
    const three = (mm[i - 2] ?? 0) + (mm[i - 1] ?? 0) + mm[i];
    wettest = Math.max(wettest, mm[i]);
    if (mm[i] * AREA_TO_POINT >= DAY_CUT_MM || three * AREA_TO_POINT >= THREE_DAY_CUT_MM) { closing[i] = true; closingDays++; }
  }
  const cut = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) if (closing[i]) for (let k = 0; k < CLOSURE_LASTS_DAYS && i + k < n; k++) cut[i + k] = true;

  // Calendar months: mean rain and mean cut-off days, over the years each month appears.
  const rainByMonth = Array(12).fill(0), cutByMonth = Array(12).fill(0), monthsSeen = Array(12).fill(0);
  let lastMonthKey = "";
  for (let i = 0; i < n; i++) {
    const m = Number(time[i].slice(5, 7)) - 1;
    rainByMonth[m] += mm[i];
    if (cut[i]) cutByMonth[m]++;
    const key = time[i].slice(0, 7);
    if (key !== lastMonthKey) { monthsSeen[m]++; lastMonthKey = key; }
  }
  for (let m = 0; m < 12; m++) { rainByMonth[m] = Math.round(rainByMonth[m] / Math.max(1, monthsSeen[m])); cutByMonth[m] = r1(cutByMonth[m] / Math.max(1, monthsSeen[m])); }

  // Seasons: 1 July → 30 June. Day-of-season index 0 = 1 July.
  const seasons: { start: number; end: number }[] = []; // index range into the arrays
  for (let i = 0; i < n; i++) if (time[i].slice(5) === "07-01") seasons.push({ start: i, end: Math.min(n - 1, i + 365) });
  const full = seasons.filter((s) => s.end - s.start >= 360);
  const onsets: number[] = [], ends: number[] = [], totals: number[] = [];
  const weekHits = Array(53).fill(0), weekRain = Array(53).fill(0);
  const trailing = (i: number, days: number) => { let s = 0; for (let k = 0; k < days; k++) s += mm[i - k] ?? 0; return s; };
  for (const s of full) {
    const len = s.end - s.start + 1;
    totals.push(mm.slice(s.start, s.end + 1).reduce((a, b) => a + b, 0));
    // Onset: first day from 1 September (day 62) with 25 mm in the last 10 days and no 10-day dry spell in the next 30.
    let onset = -1, fallback = -1;
    for (let d = 62; d < len; d++) {
      const i = s.start + d;
      if (trailing(i, 10) < ONSET_10D_MM) continue;
      if (fallback < 0) fallback = d;
      let dry = 0, spell = false;
      for (let k = 1; k <= 30 && i + k <= s.end; k++) { dry = mm[i + k] < 1 ? dry + 1 : 0; if (dry >= ONSET_DRY_SPELL_DAYS) { spell = true; break; } }
      if (!spell) { onset = d; break; }
    }
    if (onset < 0) onset = fallback;
    if (onset >= 0) onsets.push(onset);
    // Cessation: last day after 1 January (day 184) with rain and 20 mm in the trailing 10 days.
    for (let d = len - 1; d >= 184; d--) { const i = s.start + d; if (mm[i] >= 1 && trailing(i, 10) >= CESSATION_10D_MM) { ends.push(d); break; } }
    const hit = Array(53).fill(false);
    for (let d = 0; d < len; d++) { const w = Math.min(52, Math.floor(d / 7)); weekRain[w] += mm[s.start + d]; if (closing[s.start + d]) hit[w] = true; }
    hit.forEach((h, w) => { if (h) weekHits[w]++; });
  }
  const years = full.length || 1;
  const closureWeekFreq = weekHits.map((h) => Math.round((h / years) * 100) / 100);
  const weekMean = weekRain.map((x) => x / years);
  let peakWeek = 0, peakSum = -1;
  for (let w = 0; w + 4 <= 53; w++) { const sum = weekMean[w] + weekMean[w + 1] + weekMean[w + 2] + weekMean[w + 3]; if (sum > peakSum) { peakSum = sum; peakWeek = w; } }
  const toMMDD = (dayOfSeason: number) => addDays("2001-07-01", Math.round(dayOfSeason)).slice(5); // 2001-02 is not a leap year
  return {
    cell: cellKey(cell), lat: cell.lat, lng: cell.lng, years,
    typical: { start: toMMDD(median(onsets)), end: toMMDD(median(ends)) },
    onsetSpreadDays: Math.round(stddev(onsets)),
    seasonRainMm: Math.round(mean(totals)),
    rainByMonth, cutOffDaysByMonth: cutByMonth, closureWeekFreq, rainPeakWeek: peakWeek, wettestDayMm: r1(wettest), closingDays,
  };
}

// Fetch (or re-use) the archive for every post's cell and compute each cell once.
export async function getSeasons(opts: { refresh?: boolean } = {}): Promise<{ store: Store; sites: Site[] }> {
  const list = await sites();
  const range = archiveRange();
  const run = async () => {
    const s = store ?? (await fromDisk());
    const cells = new Map<string, { lat: number; lng: number }>();
    for (const site of list) { const c = cellOf(site.lat, site.lng); cells.set(cellKey(c), c); }
    const fresh = s && s.range.start === range.start && s.range.end === range.end && Date.now() - s.fetchedAt < TTL_MS && !opts.refresh;
    const missing = [...cells.values()].filter((c) => !s?.cells[cellKey(c)] || !fresh);
    if (s && !missing.length) { store = s; return s; }
    const next: Store = { range, fetchedAt: Date.now(), cells: { ...(s && s.range.start === range.start ? s.cells : {}) } };
    let got = 0;
    try {
      await fetchArchive(missing, range, (rows) => {
        for (const r of rows) { const c = { lat: r.lat, lng: r.lng }; next.cells[cellKey(c)] = computeCellSeason(c, r.time, r.mm); got++; }
      });
      delete next.errors;
    } catch (e) {
      // Keep whatever arrived (and the saved copy's cells); the missing cells are fetched next call.
      next.errors = `${e instanceof Error ? e.message : e} (${got} of ${missing.length} cells fetched this time${s ? ", the rest from the saved copy" : ""})`;
      if (!got && s) next.fetchedAt = s.fetchedAt;
    }
    store = next;
    toDisk(next).catch(() => {});
    return next;
  };
  if (!inflight) inflight = run().finally(() => { inflight = null; });
  return { store: await inflight, sites: list };
}

// Season dates for one post, placed in the current or coming season.
export function seasonFor(site: Site, s: Store, today = new Date()): PostSeason | null {
  const c = s.cells[cellKey(cellOf(site.lat, site.lng))];
  if (!c) return null;
  const season = seasonStartFor(today);
  const onDate = (mmdd: string) => { const d = `${season.slice(0, 4)}-${mmdd}`; return d < season ? `${Number(season.slice(0, 4)) + 1}-${mmdd}` : d; };
  const weekDate = (w: number) => addDays(season, w * 7);
  const closureWeeks: ClosureWeek[] = [];
  c.closureWeekFreq.forEach((f, w) => { if (f >= CLOSURE_WEEK_MIN_FREQ) closureWeeks.push({ from: weekDate(w), to: addDays(weekDate(w), 6), yearsOutOf: c.years, frequency: f }); });
  const closureStart = closureWeeks[0]?.from ?? null, closureEnd = closureWeeks.length ? closureWeeks[closureWeeks.length - 1].to : null;
  const peakFrom = addDays(weekDate(c.rainPeakWeek), 28), peakTo = addDays(weekDate(c.rainPeakWeek + 4), 56);
  const cutOffDaysInSeason = r1(c.cutOffDaysByMonth.reduce((a, b) => a + b, 0));
  const confidence: PostSeason["confidence"] = c.years < 7 ? "low" : c.onsetSpreadDays <= 12 ? "high" : c.onsetSpreadDays <= 24 ? "medium" : "low";
  const confidenceWhy = `${c.years} seasons of ERA5; the onset varies by ±${c.onsetSpreadDays} days between years; ${c.closingDays} road-closing days in the record (cell average ×${AREA_TO_POINT}); wettest cell-average day ${c.wettestDayMm} mm`;
  return {
    ...site, cell: c.cell,
    wetSeasonStart: onDate(c.typical.start), wetSeasonEnd: onDate(c.typical.end), typical: c.typical,
    closureWeeks, closureStart, closureEnd, cutOffDaysByMonth: c.cutOffDaysByMonth, cutOffDaysInSeason,
    malariaPeak: { from: peakFrom, to: peakTo },
    confidence, confidenceWhy, seasonRainMm: c.seasonRainMm, rainByMonth: c.rainByMonth, years: c.years,
    source: `Open-Meteo archive (ERA5 reanalysis, ~0.25° cell ${c.cell}), daily rain ${s.range.start} → ${s.range.end}; closure marks from model.ts (${DAY_CUT_MM} mm/day or ${THREE_DAY_CUT_MM} mm/72 h) applied to the cell average ×${AREA_TO_POINT}`,
  };
}
