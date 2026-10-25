import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";

// Terrain tracks: off-road motorbike and bicycle lines (and drone pads) proposed from free satellite
// data by the Python tool in tools/terrain. The tool writes data/terrain-tracks.json, terrain-pads.json
// and terrain-meta.json; this module reads them and can run the tool for one post.

export type TerrainTrack = {
  id: string;
  fromVillageId: number;
  fromName: string;
  toCluster: { lat: number; lng: number; buildings: number };
  vehicle: "motorbike" | "bicycle";
  season: "dry" | "wet";
  lengthKm: number;
  minutes: number;
  maxSlopeDeg: number;
  meanSlopeDeg: number;
  climbM: number;
  crossings: number;
  surface: { road: number; open: number; crop: number; bush: number; wet: number; unknown: number };
  roadKm: number | null;
  roadMinutes: number | null;
  roadNearM: number | null;
  reason: string;
  confidence: number;
  status: "proposed";
  line: [number, number][];
};

export type TerrainPad = {
  villageId: number;
  atPost: boolean;
  cluster?: { lat: number; lng: number; buildings: number };
  lat: number;
  lng: number;
  slopeDeg: number;
  cover: string;
  sizeM: number;
  distanceM: number;
  score: number;
  near: string;
  buildings: number;
  status: "proposed";
};

export type TerrainPostSummary = {
  villageId: number;
  name: string;
  generatedAt: string;
  seconds: number;
  buildings: number;
  clustersInBox: number;
  villages: { lat: number; lng: number; buildings: number; km: number; roadM: number | null }[];
  tracks: number;
  pads: number;
  dropped: { village: { buildings: number; km: number }; vehicle: string; season: string; why: string }[];
  roadsSource: "osm" | "osrm";
  rivers: string[];
  cover: Record<string, number>;
  sentinel2: { dry: { scenes: { id: string; date: string; cloud: number }[]; coverage: number }; wet: { scenes: { id: string; date: string; cloud: number }[]; coverage: number } };
  rules: string[];
};

export type TerrainMeta = {
  posts: Record<string, TerrainPostSummary>;
  sources: { name: string; use: string; url: string; keyless: boolean }[];
  updatedAt?: string;
};

// Same convention as the other libs: DATA_DIR from .env.local, else <cwd>/data. The dev server is not
// always started from the repo, so the tool folder is found next to the data folder, or via TERRAIN_TOOL_DIR.
const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const TOOL = process.env.TERRAIN_TOOL_DIR ?? path.join(path.dirname(DATA), "tools", "terrain");
export const TRACKS_FILE = path.join(DATA, "terrain-tracks.json");
export const PADS_FILE = path.join(DATA, "terrain-pads.json");
export const META_FILE = path.join(DATA, "terrain-meta.json");
export const LOG_FILE = path.join(DATA, "terrain.log");

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function readTracks(): Promise<TerrainTrack[] | null> {
  try {
    await fs.access(TRACKS_FILE);
  } catch {
    return null;
  }
  return readJson<TerrainTrack[]>(TRACKS_FILE, []);
}

export const readPads = () => readJson<TerrainPad[]>(PADS_FILE, []);
export const readMeta = () => readJson<TerrainMeta>(META_FILE, { posts: {}, sources: [] });

// One generation at a time: the tool downloads tiles and runs Dijkstra on a 1300 x 1300 grid.
let running: { villageId: number; startedAt: number; promise: Promise<GenerateResult> } | null = null;
export type GenerateResult = { ok: boolean; villageId: number; seconds: number; output: string; error?: string };

export function generationInProgress() {
  return running ? { villageId: running.villageId, startedAt: running.startedAt } : null;
}

export async function generateFor(villageId: number, capMs = 10 * 60 * 1000): Promise<GenerateResult> {
  if (running) {
    if (running.villageId === villageId) return running.promise;
    return { ok: false, villageId, seconds: 0, output: "", error: `Already generating for post #${running.villageId}; wait for it to finish.` };
  }
  const startedAt = Date.now();
  const promise = (async () => {
    const python = path.join(TOOL, ".venv", "bin", "python");
    try {
      await fs.access(python);
    } catch {
      return { ok: false, villageId, seconds: 0, output: "", error: "The terrain tool is not installed: run tools/terrain/setup.sh first." };
    }
    await fs.mkdir(DATA, { recursive: true });
    const log = await fs.open(LOG_FILE, "a");
    await log.write(`\n[${new Date().toISOString()}] generate village=${villageId}\n`);
    const chunks: string[] = [];
    const child = spawn(python, [path.join(TOOL, "terrain_tracks.py"), "--village", String(villageId)], { cwd: TOOL, env: { ...process.env, PYTHONUNBUFFERED: "1", TERRAIN_OUT: DATA } });
    const onData = (buf: Buffer) => {
      const s = buf.toString();
      chunks.push(s);
      log.write(s).catch(() => undefined);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        chunks.push("\n[killed: 10-minute cap]\n");
      }, capMs);
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        chunks.push(`\n[spawn error] ${e.message}\n`);
        resolve(-1);
      });
    });
    await log.write(`[${new Date().toISOString()}] exit ${code}\n`);
    await log.close();
    const output = chunks.join("").slice(-20000);
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    return code === 0 ? { ok: true, villageId, seconds, output } : { ok: false, villageId, seconds, output, error: code === null ? "Stopped at the 10-minute cap." : `The tool exited with code ${code}.` };
  })();
  running = { villageId, startedAt, promise };
  try {
    return await promise;
  } finally {
    running = null;
  }
}
