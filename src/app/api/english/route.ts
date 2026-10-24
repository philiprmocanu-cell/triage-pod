import { NextResponse } from "next/server";
import { handover, translate } from "@/lib/triage/brain";
import type { TriageResult, Turn } from "@/lib/triage/types";

export const runtime = "nodejs";

// Slow, human-readable English (Claude): translations and the doctor's handover note.
export async function POST(req: Request) {
  const body = (await req.json()) as { translate?: string; handover?: { turns: Turn[]; result: TriageResult } };
  try {
    if (body.translate) return NextResponse.json({ text: await translate(body.translate) });
    if (body.handover) return NextResponse.json({ text: await handover(body.handover.turns, body.handover.result) });
    return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  } catch (err) {
    console.error("english failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
