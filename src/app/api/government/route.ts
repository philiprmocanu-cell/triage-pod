import { NextResponse } from "next/server";
import { provincialBriefing } from "@/lib/triage/brain";

export const runtime = "nodejs";

// The government view sends a compact picture of the province (stock, demand, what the agents
// did); Claude writes the briefing a Provincial Medical Officer would read before a decision.
export async function POST(req: Request) {
  const state = (await req.json()) as Record<string, unknown>;
  try {
    return NextResponse.json({ text: await provincialBriefing(state) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Briefing failed" }, { status: 500 });
  }
}
