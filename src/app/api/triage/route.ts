import { NextResponse } from "next/server";
import { step, StepInput } from "@/lib/triage/engine";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json()) as StepInput;
  try {
    return NextResponse.json(await step(body));
  } catch (err) {
    console.error("triage failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Triage failed" }, { status: 500 });
  }
}
