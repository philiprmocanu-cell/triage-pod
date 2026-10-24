import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { pressure } from "@/lib/pressure";
import { epiFor } from "@/lib/triage/engine";

export const runtime = "nodejs";

// GET /api/pressure?village=Katete[&region=Rural Zambia]
// -> { village, level, score, priorFactor, priorShift, reasons[], parts, line }
// The score reads the satellite's saved answer; when that is missing or older than six hours the
// satellite route is asked first (it refreshes its disk copy), so the pod does not score on
// last week's weather.
const STALE_MS = 6 * 3600_000;
const satelliteFile = () => path.join(process.env.DATA_DIR ?? "data", "satellite.json");

export async function GET(req: Request) {
  const url = new URL(req.url);
  const village = url.searchParams.get("village")?.trim() || "Katete";
  const region = url.searchParams.get("region") ?? "Rural Zambia (Eastern Province)";
  await refreshSatellite(url.origin);
  const p = await pressure(village, { malariaRegion: epiFor(region).malaria });
  return NextResponse.json({ ...p, line: `${p.level.toUpperCase()} — ${p.reasons.join(", ")}` });
}

async function refreshSatellite(origin: string) {
  try {
    const stat = await fs.stat(satelliteFile()).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs < STALE_MS) return;
    await fetch(`${origin}/api/satellite`, { signal: AbortSignal.timeout(20_000) }).catch(() => {});
  } catch {
    // the score says "no satellite reading" when there is none
  }
}
