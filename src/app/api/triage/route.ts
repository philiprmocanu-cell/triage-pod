import { NextResponse } from "next/server";
import { step, StepInput } from "@/lib/triage/engine";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json()) as StepInput;
  try {
    return NextResponse.json(await step(body));
  } catch (err) {
    console.error("triage failed", err);
    const msg = err instanceof Error ? err.message : "Triage failed";
    // Jev makes every decision: when it is down, the screen says so plainly instead of guessing.
    const plain = /jev|typesafe/i.test(msg) ? `The triage brain (Jev) is not answering, so nothing was decided this turn. Try again; if it keeps failing, use the pod's judgement and call the health worker. (${msg})` : msg;
    return NextResponse.json({ error: plain }, { status: 500 });
  }
}
