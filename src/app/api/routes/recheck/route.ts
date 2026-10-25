import { NextResponse } from "next/server";
import { getLastRecheck, recheckAll } from "@/lib/routes/planner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The route watcher. POST re-scores every route_plan that is not done against the current
// /api/weather/road answer and the measured road surface; a leg that moved to high is planned
// again (alternative road, else a carrier that does not need the road) and marked `rerouted`,
// with a "Route watcher" line in the agent log. → { at, checked, rerouted[], changed[], errors[] }.
// GET returns the last result without checking. The Routes page calls POST every 10 minutes while
// open and whenever /api/weather/outlook reports a fresh cache. See docs/ROUTES.md.
let running: Promise<unknown> | null = null;

export async function POST(req: Request) {
  const origin = new URL(req.url).origin;
  try {
    if (!running) running = recheckAll(origin).finally(() => { running = null; });
    return NextResponse.json(await running);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json(getLastRecheck() ?? { at: null, checked: 0, rerouted: [], changed: [], errors: [] });
}
