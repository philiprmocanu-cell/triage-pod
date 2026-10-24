import { NextResponse } from "next/server";
import { judgeTest } from "@/lib/triage/engine";
import type { Frame } from "@/lib/triage/types";

export const runtime = "nodejs";

// Jev watches the pictures taken while the patient did a physical test (walk, crouch, smile...).
export async function POST(req: Request) {
  const { testId, frames, region } = (await req.json()) as { testId: string; frames: Frame[]; region: string };
  try {
    return NextResponse.json(await judgeTest(testId, frames, region));
  } catch (err) {
    console.error("test failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Test failed" }, { status: 500 });
  }
}
