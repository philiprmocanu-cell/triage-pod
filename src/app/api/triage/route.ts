import { NextResponse } from "next/server";
import { BrainInput, runTriage } from "@/lib/triage/brain";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json()) as BrainInput;
  try {
    return NextResponse.json(await runTriage(body));
  } catch (err) {
    console.error("triage failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Triage failed" }, { status: 500 });
  }
}
