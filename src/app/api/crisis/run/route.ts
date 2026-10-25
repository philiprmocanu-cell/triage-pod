import { NextResponse } from "next/server";
import { callReducer } from "@/lib/dispatch/state";
import { getCrisisRun, isCrisisRunning, runCrisis } from "@/lib/dispatch/crisis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST { level: 1 | 2 | 3 } runs the whole crisis drill on the live network and answers with the
// step-by-step log, timings and totals (see src/lib/dispatch/crisis.ts and docs/CRISIS.md).
// While it runs, GET /api/crisis/status shows the steps as they happen.
// POST { clear: true } takes the drill down (clear_crisis reducer).
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { level?: number; clear?: boolean };
  const origin = new URL(req.url).origin;
  try {
    if (body.clear) {
      if (isCrisisRunning()) return NextResponse.json({ error: "a run is in progress; wait for it to finish" }, { status: 409 });
      await callReducer("clear_crisis", []);
      return NextResponse.json({ cleared: true, last: await getCrisisRun() });
    }
    if (isCrisisRunning()) return NextResponse.json({ error: "a run is already in progress", run: await getCrisisRun() }, { status: 409 });
    const run = await runCrisis(Number(body.level ?? 3), origin);
    return NextResponse.json(run, { status: run.error ? 500 : 200 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
