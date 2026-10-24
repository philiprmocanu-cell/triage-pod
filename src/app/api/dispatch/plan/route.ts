import { NextResponse } from "next/server";
import { explainPlan, explainWithClaude } from "@/lib/dispatch/explain";
import { planDispatch } from "@/lib/dispatch/plan";
import { loadState } from "@/lib/dispatch/state";
import { savePlan } from "@/lib/dispatch/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The dispatch brain, run on the live network: reads SpacetimeDB, the weather outlook and the
// carriers, ranks the shipments and explains them. Deterministic; POST { explain: "claude" }
// asks Claude to word the explanation instead (same facts, same plan).
async function run(req: Request, explain: "planner" | "claude") {
  const origin = new URL(req.url).origin;
  try {
    const state = await loadState(origin);
    const plan = planDispatch(state);
    await savePlan(plan).catch(() => {});
    const worded = explain === "claude" ? await explainWithClaude(plan) : { text: explainPlan(plan), by: "planner" as const };
    return NextResponse.json({ plan, explanation: worded.text, explainedBy: worded.by });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Planning failed" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return run(req, new URL(req.url).searchParams.get("explain") === "claude" ? "claude" : "planner");
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { explain?: string };
  return run(req, body.explain === "claude" ? "claude" : "planner");
}
