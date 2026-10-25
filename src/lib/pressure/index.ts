// Malaria pressure: how likely it is, before a single question, that a fever in THIS village this
// week is malaria. Three things the pod already knows are combined into one score from 0 to 1:
//
//   vector   what the mosquito listener heard here in the last 7 days (Anopheles = malaria vectors)
//   weather  the satellite's rain and temperature over the post (standing water + warm nights)
//   cases    malaria named on visits saved here in the last 14 days
//
//   score = 0.50 * vector + 0.25 * weather + 0.25 * cases
//   vector  = min(1, anopheles / 8 + other / 40)        8 vector wingbeats in a week saturate it
//   weather = outlook if the satellite gives one, else risk high 1 / medium 0.5 / low 0
//   cases   = min(1, cases / 3)                           3 cases in two weeks saturate it
//   level   = high at 0.45 and up, medium at 0.2, else low
//
// The score only moves the STARTING probability of malaria among the fever causes (priorFactor:
// low 0.6x, medium about 1.2x, high 1.5x to 2.5x) and the order the fever questions are asked in.
// It never decides: the rapid test is ordered for every fever in a malaria region whatever the
// score says, and a positive test, not this number, makes the diagnosis.

import { promises as fs } from "fs";
import path from "path";
import { readRegistry } from "../registry";
import { sightingsFor, type SightingCounts } from "../mosquito/sightings";
import type { PostWeather } from "@/app/api/satellite/route";

export type PressureLevel = "low" | "medium" | "high";

export type Pressure = {
  village: string;
  applies: boolean; // false outside malaria regions: everything below is zero
  level: PressureLevel;
  score: number; // 0..1
  priorFactor: number; // multiply the malaria causes' starting probability by this
  priorShift: number; // the same as a change: +0.55 = 55% more likely to start with, -0.4 = 40% less
  reasons: string[]; // what the score is made of, in plain words, for the screen
  parts: {
    vector: { value: number; anopheles: number; other: number; clips: number; species: Record<string, number>; lastHeard: string | null };
    weather: { value: number; rain30Mm: number | null; lastYearRain30Mm: number | null; meanTempC: number | null; risk: "low" | "medium" | "high" | null; outlook6w: number | null; rainNext14Mm: number | null; post: string | null };
    cases: { value: number; count: number; days: number };
  };
  computedAt: string;
};

const WEIGHTS = { vector: 0.5, weather: 0.25, cases: 0.25 };
const HIGH = 0.45;
const MEDIUM = 0.2;
const SIGHTING_DAYS = 7;
const CASE_DAYS = 14;

// Fields another agent may add to the satellite answer; used when present, ignored otherwise.
type PostWeatherPlus = PostWeather & { rainNext14Mm?: number; malariaOutlook6w?: number | "low" | "medium" | "high" };

const satelliteFile = () => path.join(process.env.DATA_DIR ?? "data", "satellite.json");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// The satellite route keeps its last good answer on disk; that is what the score reads.
async function weatherFor(village: string): Promise<PostWeatherPlus | null> {
  try {
    const saved = JSON.parse(await fs.readFile(satelliteFile(), "utf8")) as { data: PostWeatherPlus[] };
    const v = norm(village), first = v.split(" ")[0];
    return saved.data.find((p) => norm(p.name) === v) ?? saved.data.find((p) => p.id === first || norm(p.name).split(" ")[0] === first) ?? null;
  } catch {
    return null;
  }
}

// Visits saved at this post in the last two weeks where malaria was a named cause.
async function casesFor(village: string): Promise<number> {
  const since = Date.now() - CASE_DAYS * 86_400_000;
  const v = norm(village), first = v.split(" ")[0];
  const here = (s: string | null | undefined) => {
    if (!s) return false;
    const n = norm(s);
    return n === v || n.split(" ").includes(first);
  };
  const all = await readRegistry();
  return all.filter((r) => Date.parse(r.createdAt) >= since && (here(r.village) || here(r.community)) && r.causes.some((c) => /malaria/i.test(c.name) && c.probability >= 0.5)).length;
}

const levelOf = (score: number): PressureLevel => (score >= HIGH ? "high" : score >= MEDIUM ? "medium" : "low");
const riskValue = (r: string | number | null | undefined) => (typeof r === "number" ? Math.max(0, Math.min(1, r)) : r === "high" ? 1 : r === "medium" ? 0.5 : 0);

export async function pressure(village: string, opts: { malariaRegion?: boolean } = {}): Promise<Pressure> {
  const applies = opts.malariaRegion ?? true;
  const [heard, weather, cases] = applies ? await Promise.all([sightingsFor(village, SIGHTING_DAYS), weatherFor(village), casesFor(village)]) : [emptyCounts(village), null, 0];

  const vector = Math.min(1, heard.anopheles / 8 + heard.other / 40);
  // The satellite's own risk flag already guards against NASA's preliminary rain being out of all
  // proportion to last year; an outlook (if the satellite agent adds one) is more direct, so it wins.
  const outlook = weather?.malariaOutlook6w != null ? riskValue(weather.malariaOutlook6w) : null;
  const weatherValue = weather ? (outlook ?? riskValue(weather.malariaRisk)) : 0;
  const caseValue = Math.min(1, cases / 3);
  const score = applies ? Math.round((WEIGHTS.vector * vector + WEIGHTS.weather * weatherValue + WEIGHTS.cases * caseValue) * 100) / 100 : 0;
  const level = levelOf(score);
  const priorFactor = applies ? Math.round((0.6 + 1.9 * score) * 100) / 100 : 1;

  const reasons: string[] = [];
  if (!applies) reasons.push("no malaria transmission in this region");
  else {
    reasons.push(
      heard.anopheles
        ? `Anopheles heard ${heard.anopheles}× in ${SIGHTING_DAYS} days${heard.other ? ` (${heard.other} other mosquitoes)` : ""}`
        : heard.clips
          ? `${heard.clips} clip${heard.clips === 1 ? "" : "s"} listened to, no malaria mosquito heard`
          : "nothing heard by the listener yet",
    );
    if (weather) {
      const rain = `${Math.round(weather.rain30Mm)} mm rain in 30 days`;
      const temp = `${Math.round(weather.meanTempC)} °C`;
      reasons.push(outlook != null ? `${rain}, ${temp}, satellite outlook ${Math.round(outlook * 100)}%` : `${rain}, ${temp} (satellite risk ${weather.malariaRisk})`);
    } else reasons.push("no satellite reading for this post yet");
    reasons.push(cases ? `${cases} malaria case${cases === 1 ? "" : "s"} in ${CASE_DAYS} days` : `no malaria cases in ${CASE_DAYS} days`);
  }

  return {
    village,
    applies,
    level,
    score,
    priorFactor,
    priorShift: Math.round((priorFactor - 1) * 100) / 100,
    reasons,
    parts: {
      vector: { value: Math.round(vector * 100) / 100, anopheles: heard.anopheles, other: heard.other, clips: heard.clips, species: heard.species, lastHeard: heard.lastHeard },
      weather: {
        value: weatherValue,
        rain30Mm: weather?.rain30Mm ?? null,
        lastYearRain30Mm: weather?.lastYearRain30Mm ?? null,
        meanTempC: weather?.meanTempC ?? null,
        risk: weather?.malariaRisk ?? null,
        outlook6w: outlook,
        rainNext14Mm: weather?.rainNext14Mm ?? null,
        post: weather?.name ?? null,
      },
      cases: { value: caseValue, count: cases, days: CASE_DAYS },
    },
    computedAt: new Date().toISOString(),
  };
}

function emptyCounts(village: string): SightingCounts {
  return { village, days: SIGHTING_DAYS, clips: 0, anopheles: 0, other: 0, lastHeard: null, species: {}, mapped: null };
}

// One line for a screen: "HIGH — Anopheles heard 14× in 7 days, 120 mm rain in 30 days, 26 °C (satellite risk high), 3 malaria cases in 14 days".
export function pressureLine(p: Pressure): string {
  return `${p.level.toUpperCase()} — ${p.reasons.join(", ")}`;
}
