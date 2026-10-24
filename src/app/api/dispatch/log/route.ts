import { NextResponse } from "next/server";
import { sql } from "@/lib/dispatch/state";
import { readStore, type DispatchLogLine } from "@/lib/dispatch/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The dispatch planner's own log: lines in `agent_log` (when the module has `log_agent`) merged
// with the lines kept in data/dispatch.json, newest first. The agents page and the government
// page read this.
export async function GET() {
  const store = await readStore();
  const fromFile = store.log.filter((l) => l.where === "file");
  let fromDb: DispatchLogLine[] = [];
  try {
    const rows = await sql("SELECT * FROM agent_log WHERE agent = 'Dispatch planner'");
    const villages = await sql("SELECT id, name FROM village");
    const name = (id: number) => String(villages.find((v) => Number(v.id) === id)?.name ?? "").replace(/ \(.*\)$/, "");
    fromDb = rows.map((r) => {
      const at = Array.isArray(r.at) ? Number((r.at as number[])[0]) / 1000 : 0;
      return { id: Number(r.id), at: new Date(at).toISOString(), agent: "Dispatch planner" as const, villageId: Number(r.village_id), village: name(Number(r.village_id)), text: String(r.text), where: "agent_log" as const };
    });
  } catch {
    // database down: the file is all there is
  }
  const lines = [...fromDb, ...fromFile].sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id).slice(0, 60);
  return NextResponse.json({ lines, lastPlanAt: store.lastPlan?.plannedAt ?? null, executions: store.executions.slice(-5).reverse() });
}
