import type { CellForecast, CellRiver } from "./openmeteo";
import type { FloodNear } from "./gibs";

// The rules that turn rain, river and satellite-water numbers into the three words a dispatcher
// acts on (low / medium / high) and "roads may close in N days". Plain thresholds, named here so
// the district can tune them from experience; none of this is a hydrological model of a road.

export type Risk = "low" | "medium" | "high";

export const DAY_CUT_MM = 40; // one day this wet: the same mark /api/satellite already uses for floodRisk
export const THREE_DAY_CUT_MM = 80; // three wet days in a row saturate the ground and cut fords
export const DAY_WARN_MM = 20;
export const THREE_DAY_WARN_MM = 40;
export const FORTNIGHT_HIGH_MM = 150; // a month's worth of rain in two weeks
export const FORTNIGHT_MED_MM = 80;
export const RIVER_HIGH = 1.5; // forecast discharge vs last year's 95th percentile
export const RIVER_MED = 1.0;
export const RIVER_MIN_M3S = 0.05; // below this the GloFAS cell holds no real river; the ratio means nothing
export const FLOOD_PX_HIGH = 1; // % of observed pixels showing unusual flood near a point
export const FLOOD_PX_MED = 10; // % showing recurring flood / standing water
export const SOIL_WET_MM = 40; // rain in the last 7 days that leaves the ground saturated

const r1 = (x: number) => Math.round(x * 10) / 10;
const sum = (xs: number[]) => r1(xs.reduce((s, x) => s + x, 0));
export const worst = (...xs: Risk[]): Risk => (xs.includes("high") ? "high" : xs.includes("medium") ? "medium" : "low");

export type RainSummary = {
  rain30Mm: number; rain7Mm: number; rain72hMm: number;
  rainNext14Mm: number; wettestForecastDayMm: number; wettestForecastDate: string | null;
  rainNext14Days: { date: string; mm: number; prob: number | null }[];
  meanTempC: number | null; // past 30 + next 16 days, (max+min)/2
  modelRun: string;
};

export function summarizeRain(c: CellForecast): RainSummary {
  const next14 = c.future.slice(0, 14);
  const wettest = c.future.reduce((w, d) => (d.mm > w.mm ? d : w), { date: null as string | null, mm: 0 });
  const temps = [...c.past, ...c.future].flatMap((d) => (d.tMaxC !== null && d.tMinC !== null ? [(d.tMaxC + d.tMinC) / 2] : []));
  return {
    rain30Mm: sum(c.past.map((d) => d.mm)),
    rain7Mm: sum(c.past.slice(-7).map((d) => d.mm)),
    rain72hMm: sum(c.past.slice(-3).map((d) => d.mm)),
    rainNext14Mm: sum(next14.map((d) => d.mm)),
    wettestForecastDayMm: r1(wettest.mm),
    wettestForecastDate: wettest.mm > 0 ? wettest.date : null,
    rainNext14Days: next14.map((d) => ({ date: d.date, mm: r1(d.mm), prob: d.prob })),
    meanTempC: temps.length ? r1(temps.reduce((s, t) => s + t, 0) / temps.length) : null,
    modelRun: c.modelRun,
  };
}

export type RiverRise = { ratio: number | null; todayRatio: number | null; forecastMaxM3s: number; todayM3s: number; baselineP95M3s: number; peakDate: string | null; note: string };

// How the forecast river compares with the wettest 5 % of days in the past year, in the same cell.
export function riverRise(c: CellRiver): RiverRise {
  const hist = [...c.history].sort((a, b) => a - b);
  const p95 = hist.length ? hist[Math.min(hist.length - 1, Math.floor(hist.length * 0.95))] : 0;
  const max = Math.max(0, ...c.future);
  const today = c.future[0] ?? 0;
  const peakIdx = c.future.indexOf(max);
  const peakDate = max > 0 && peakIdx >= 0 ? addDays(c.dates.today, peakIdx) : null;
  const noRiver = p95 < RIVER_MIN_M3S;
  return {
    ratio: noRiver ? null : Math.round((100 * max) / p95) / 100,
    todayRatio: noRiver ? null : Math.round((100 * today) / p95) / 100,
    forecastMaxM3s: Math.round(max * 100) / 100,
    todayM3s: Math.round(today * 100) / 100,
    baselineP95M3s: Math.round(p95 * 100) / 100,
    peakDate,
    note: noRiver ? "no sizeable river in this 5 km cell; river signal not used" : `forecast peak ${Math.round(max * 100) / 100} m³/s vs last year's 95th percentile ${Math.round(p95 * 100) / 100} m³/s`,
  };
}

export function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export type CutOff = { cutOffDays: number | null; cutOffRisk: string; cutOffDate: string | null };

// First day in the forecast on which rain reaches a road-closing amount (one day ≥ 40 mm, or
// three days ≥ 80 mm), counted from today. Flood seen by satellite or 80 mm in the last 72 h
// means the roads may already be cut.
export function cutOff(c: CellForecast, rain: RainSummary, flood: FloodNear | null): CutOff {
  if ((flood && flood.inside && flood.floodPct >= FLOOD_PX_HIGH) || rain.rain72hMm >= THREE_DAY_CUT_MM) {
    const why = flood && flood.floodPct >= FLOOD_PX_HIGH ? `satellite sees flood water within ${flood.radiusKm} km` : `${rain.rain72hMm} mm fell in the last 72 h`;
    return { cutOffDays: 0, cutOffRisk: `roads may already be cut (${why})`, cutOffDate: c.future[0]?.date ?? null };
  }
  const series = [...c.past.slice(-2), ...c.future];
  for (let i = 2; i < series.length; i++) {
    const day = series[i], three = series[i - 2].mm + series[i - 1].mm + day.mm;
    if (day.mm >= DAY_CUT_MM || three >= THREE_DAY_CUT_MM) {
      const n = i - 2;
      const amount = day.mm >= DAY_CUT_MM ? `${r1(day.mm)} mm on ${day.date}` : `${r1(three)} mm over the three days to ${day.date}`;
      return { cutOffDays: n, cutOffRisk: n === 0 ? `roads may close today (${amount})` : `roads may close in ${n} day${n === 1 ? "" : "s"} (${amount})`, cutOffDate: day.date };
    }
  }
  return { cutOffDays: null, cutOffRisk: `no road-closing rain in the ${c.future.length}-day forecast`, cutOffDate: null };
}

export function floodRiskToday(rain: RainSummary, river: RiverRise | null, flood: FloodNear | null): { risk: Risk; reasons: string[] } {
  const reasons: string[] = [];
  let risk: Risk = "low";
  const bump = (r: Risk, why: string) => { risk = worst(risk, r); reasons.push(why); };
  if (flood?.inside && flood.floodPct >= FLOOD_PX_HIGH) bump("high", `NASA flood map: ${flood.floodPct}% of the observed area within ${flood.radiusKm} km is under unusual flood water`);
  else if (flood?.inside && flood.recurringPct + flood.waterPct >= FLOOD_PX_MED) bump("medium", `NASA flood map: ${r1(flood.recurringPct + flood.waterPct)}% of the observed area within ${flood.radiusKm} km is standing water`);
  if (rain.rain72hMm >= THREE_DAY_CUT_MM) bump("high", `${rain.rain72hMm} mm of rain in the last 72 h`);
  else if (rain.rain72hMm >= THREE_DAY_WARN_MM) bump("medium", `${rain.rain72hMm} mm of rain in the last 72 h`);
  if (river?.todayRatio !== null && river?.todayRatio !== undefined) {
    if (river.todayRatio >= RIVER_HIGH) bump("high", `GloFAS river today ${river.todayRatio}× last year's 95th percentile`);
    else if (river.todayRatio >= RIVER_MED) bump("medium", `GloFAS river today ${river.todayRatio}× last year's 95th percentile`);
  }
  if (!reasons.length) reasons.push(`${rain.rain72hMm} mm in the last 72 h` + (flood?.inside ? `; satellite saw ${flood.observedPct}% of the area, no unusual flood water` : ""));
  return { risk, reasons };
}

export function floodRisk14d(rain: RainSummary, river: RiverRise | null, flood: FloodNear | null): { risk: Risk; reasons: string[] } {
  const reasons: string[] = [];
  let risk: Risk = "low";
  const bump = (r: Risk, why: string) => { risk = worst(risk, r); reasons.push(why); };
  const wet = rain.rain7Mm >= SOIL_WET_MM;
  if (rain.wettestForecastDayMm >= DAY_CUT_MM) bump("high", `${rain.wettestForecastDayMm} mm forecast on ${rain.wettestForecastDate}`);
  else if (rain.wettestForecastDayMm >= DAY_WARN_MM) bump("medium", `${rain.wettestForecastDayMm} mm forecast on ${rain.wettestForecastDate}`);
  if (rain.rainNext14Mm >= FORTNIGHT_HIGH_MM) bump("high", `${rain.rainNext14Mm} mm forecast over the next 14 days`);
  else if (rain.rainNext14Mm >= FORTNIGHT_MED_MM) bump("medium", `${rain.rainNext14Mm} mm forecast over the next 14 days`);
  if (wet && rain.rainNext14Mm >= FORTNIGHT_MED_MM) bump("high", `ground already wet (${rain.rain7Mm} mm in the last 7 days) with ${rain.rainNext14Mm} mm more coming`);
  else if (wet && rain.rainNext14Mm >= THREE_DAY_WARN_MM) bump("medium", `ground already wet (${rain.rain7Mm} mm in the last 7 days) with ${rain.rainNext14Mm} mm more coming`);
  if (river?.ratio !== null && river?.ratio !== undefined) {
    if (river.ratio >= RIVER_HIGH) bump("high", `GloFAS river forecast ${river.ratio}× last year's 95th percentile, peak ${river.peakDate}`);
    else if (river.ratio >= RIVER_MED) bump("medium", `GloFAS river forecast ${river.ratio}× last year's 95th percentile, peak ${river.peakDate}`);
  }
  if (flood?.inside && flood.floodPct >= FLOOD_PX_HIGH) bump("high", `already flooded on the NASA flood map (${flood.floodPct}% within ${flood.radiusKm} km)`);
  if (!reasons.length) reasons.push(`${rain.rainNext14Mm} mm forecast over 14 days, wettest day ${rain.wettestForecastDayMm} mm; ground ${wet ? "wet" : "dry"} (${rain.rain7Mm} mm in 7 days)`);
  return { risk, reasons };
}

// Anopheles need standing water for 2–3 weeks and 18–32 °C; cases follow the rain by 4–8 weeks.
// Rain that has fallen plus rain forecast is the water that will be there; the temperature says
// whether the parasite completes its cycle in the mosquito.
export function malariaOutlook(rain: RainSummary): { outlook: Risk; reason: string } {
  const t = rain.meanTempC;
  const warm = t !== null && t >= 18 && t <= 32;
  const water = r1(rain.rain30Mm + rain.rainNext14Mm);
  const outlook: Risk = warm && water >= 120 ? "high" : warm && water >= 50 ? "medium" : "low";
  const tempTxt = t === null ? "temperature unknown" : warm ? `${t} °C is inside the 18–32 °C transmission window` : `${t} °C is outside the 18–32 °C transmission window`;
  const reason = `${rain.rain30Mm} mm fell in the last 30 days and ${rain.rainNext14Mm} mm is forecast; ${tempTxt}; cases follow the rain by 4–8 weeks.`;
  return { outlook, reason };
}

// One point on a road leg, judged for a window of `days` from `start` (index into the forecast).
export type SampleRisk = { risk: Risk; reasons: string[]; rain72hMm: number; rainWindowMm: number; wettestWindowMm: number; wettestWindowDate: string | null };

export function sampleRisk(c: CellForecast, startIdx: number, days: number, river: RiverRise | null, flood: FloodNear | null): SampleRisk {
  const window = c.future.slice(Math.max(0, startIdx), Math.max(0, startIdx) + days);
  const rain72hMm = sum(c.past.slice(-3).map((d) => d.mm));
  const rainWindowMm = sum(window.map((d) => d.mm));
  const wettest = window.reduce((w, d) => (d.mm > w.mm ? d : w), { date: null as string | null, mm: 0 });
  const reasons: string[] = [];
  let risk: Risk = "low";
  const bump = (r: Risk, why: string) => { risk = worst(risk, r); reasons.push(why); };
  if (flood?.inside && flood.floodPct >= FLOOD_PX_HIGH) bump("high", `satellite sees unusual flood water (${flood.floodPct}% within ${flood.radiusKm} km)`);
  else if (flood?.inside && flood.recurringPct + flood.waterPct >= FLOOD_PX_MED) bump("medium", `standing water on the satellite map (${r1(flood.recurringPct + flood.waterPct)}% within ${flood.radiusKm} km)`);
  if (wettest.mm >= DAY_CUT_MM) bump("high", `${r1(wettest.mm)} mm forecast on ${wettest.date}`);
  else if (wettest.mm >= DAY_WARN_MM) bump("medium", `${r1(wettest.mm)} mm forecast on ${wettest.date}`);
  const soilPlus = r1(rain72hMm + rainWindowMm);
  if (soilPlus >= THREE_DAY_CUT_MM + 20) bump("high", `${rain72hMm} mm in the last 72 h plus ${rainWindowMm} mm forecast in the window`);
  else if (soilPlus >= THREE_DAY_WARN_MM + 10) bump("medium", `${rain72hMm} mm in the last 72 h plus ${rainWindowMm} mm forecast in the window`);
  if (river?.ratio !== null && river?.ratio !== undefined) {
    if (river.ratio >= RIVER_HIGH) bump("high", `river forecast ${river.ratio}× last year's 95th percentile`);
    else if (river.ratio >= RIVER_MED) bump("medium", `river forecast ${river.ratio}× last year's 95th percentile`);
  }
  if (!reasons.length) reasons.push(`${rain72hMm} mm in the last 72 h, ${rainWindowMm} mm forecast over ${window.length} day${window.length === 1 ? "" : "s"} (wettest ${r1(wettest.mm)} mm)` + (flood?.inside ? `; no flood water on the satellite map (${flood.observedPct}% of the area observed)` : ""));
  return { risk, reasons, rain72hMm, rainWindowMm, wettestWindowMm: r1(wettest.mm), wettestWindowDate: wettest.mm > 0 ? wettest.date : null };
}
