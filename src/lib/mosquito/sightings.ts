// What the listener has heard, village by village. Every clip /api/mosquito classifies is written
// here (a mosquito or not), so the malaria-pressure score can say "Anopheles heard 14 times this
// week" or "12 clips, nothing heard". One JSON file for the demo, like the registry; a real
// deployment would keep this per pod and sync it.

import { promises as fs } from "fs";
import path from "path";

export type Sighting = {
  id: string;
  at: string; // ISO time of the clip
  village: string;
  mosquito: boolean; // did the detector hear a wingbeat at all
  species: string | null; // the species model's pick, when a mosquito was heard
  probability: number; // species probability when heard, else the (low) mosquito probability
  malariaVector: boolean; // Anopheles that carries malaria in Zambia (see vectors.ts)
  tag?: string; // "seed" for test clips, so they can be cleaned up
};

export type SightingCounts = {
  village: string;
  days: number;
  clips: number; // everything listened to
  anopheles: number; // malaria vectors heard
  other: number; // mosquitoes that do not carry malaria
  lastHeard: string | null; // ISO time of the last vector heard
  species: Record<string, number>; // vector species -> count
  mapped: string | null; // a specific species, only once the model is confident
};

const DAY_MS = 86_400_000;
const file = () => path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "mosquito-sightings.json");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sameVillage = (a: string, b: string) => {
  const x = norm(a), y = norm(b);
  return x === y || x.split(" ")[0] === y.split(" ")[0];
};

export async function readSightings(): Promise<Sighting[]> {
  try {
    return JSON.parse(await fs.readFile(file(), "utf8"));
  } catch {
    return [];
  }
}

async function write(all: Sighting[]) {
  await fs.mkdir(path.dirname(file()), { recursive: true });
  await fs.writeFile(file(), JSON.stringify(all, null, 2));
}

export async function recordSighting(s: Omit<Sighting, "id" | "at"> & { at?: string }): Promise<Sighting> {
  const all = await readSightings();
  const row: Sighting = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, at: s.at ?? new Date().toISOString(), ...s };
  all.push(row);
  await write(all);
  return row;
}

// Counts for one village over the last `days` days.
export function countSightings(all: Sighting[], village: string, days = 7): SightingCounts {
  const since = Date.now() - days * DAY_MS;
  const rows = all.filter((s) => sameVillage(s.village, village) && Date.parse(s.at) >= since);
  const vectors = rows.filter((s) => s.mosquito && s.malariaVector);
  const species: Record<string, number> = {};
  for (const v of vectors) if (v.species) species[v.species] = (species[v.species] ?? 0) + 1;
  const mapped = rows
    .filter((s) => s.mosquito && s.species && s.probability >= 0.5)
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0]?.species ?? null;
  return {
    village,
    days,
    clips: rows.length,
    anopheles: vectors.length,
    other: rows.filter((s) => s.mosquito && !s.malariaVector).length,
    lastHeard: vectors.map((v) => v.at).sort().at(-1) ?? null,
    species,
    mapped,
  };
}

export async function sightingsFor(village: string, days = 7): Promise<SightingCounts> {
  return countSightings(await readSightings(), village, days);
}

// Every village heard from in the window.
export async function sightingsByVillage(days = 7): Promise<SightingCounts[]> {
  const all = await readSightings();
  const since = Date.now() - days * DAY_MS;
  const names = [...new Set(all.filter((s) => Date.parse(s.at) >= since).map((s) => s.village))];
  return names.map((v) => countSightings(all, v, days));
}

// Remove a village's clips (all of them, or only those with a tag such as "seed"). Returns how many went.
export async function removeSightings(village: string, tag?: string): Promise<number> {
  const all = await readSightings();
  const keep = all.filter((s) => !(sameVillage(s.village, village) && (!tag || s.tag === tag)));
  if (keep.length !== all.length) await write(keep);
  return all.length - keep.length;
}
