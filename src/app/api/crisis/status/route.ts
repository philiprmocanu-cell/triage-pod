import { NextResponse } from "next/server";
import { sql } from "@/lib/dispatch/state";
import { blockedLegs, getCrisisRun, isCrisisRunning } from "@/lib/dispatch/crisis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Crisis page polls this every second while a run is going: the orchestrator's steps with
// their timings, the last totals, the crisis row, the blocked legs with their road geometry
// (drawn in red) and a few live counters read straight from the tables. Everything else on the
// page comes from its own SpacetimeDB subscriptions.
export async function GET() {
  const run = await getCrisisRun();
  let crisis: Record<string, unknown> | null = null;
  let carriers: { down: number; out: number; idle: number } = { down: 0, out: 0, idle: 0 };
  try {
    crisis = (await sql("SELECT * FROM crisis"))[0] ?? null;
    const rows = await sql("SELECT status FROM carrier");
    carriers = { down: rows.filter((r) => r.status === "down").length, out: rows.filter((r) => r.status === "out").length, idle: rows.filter((r) => r.status === "idle").length };
  } catch {
    // database down: the run log is all there is
  }
  const blocks = await blockedLegs().catch(() => []);
  return NextResponse.json({ running: isCrisisRunning(), run, crisis, carriers, blocks, at: new Date().toISOString() });
}
