import { NextResponse } from "next/server";
import { addNote } from "@/lib/judge/evidence";
import { hasOpinion, logOpinion, secondOpinion } from "@/lib/judge/opinion";
import { judgeTest } from "@/lib/triage/engine";
import type { Frame } from "@/lib/triage/types";

export const runtime = "nodejs";

const SMILE_YES = 0.6; // the engine's YES: from here an uneven smile counts as weakness
const SMILE_OPINION_TIMEOUT_MS = 6000; // the test already took 5 s; this is the one wait before a stroke question

// Jev watches the pictures taken while the patient did a physical test (walk, crouch, smile...).
// The smile test is the one check that can lead to a stroke question, so when Jev calls it uneven,
// Claude looks at the same test pictures first; a "no" or "unclear" demotes it below the line.
export async function POST(req: Request) {
  const { testId, frames, region, session } = (await req.json()) as { testId: string; frames: Frame[]; region: string; session?: string };
  try {
    const out = await judgeTest(testId, frames, region);
    if (testId === "smile" && out.attempted && (out.results.face_or_arm_weakness ?? 0) >= SMILE_YES && hasOpinion()) {
      const jev = out.results.face_or_arm_weakness!;
      const op = await secondOpinion(frames, ["face_droop"], { rubric: "smile", timeoutMs: SMILE_OPINION_TIMEOUT_MS, wholeFrames: 4, closeups: 0 });
      const v = op.verdicts.face_droop;
      const agree = v.verdict === "yes";
      // No answer at all (capped key, outage) is not a "no": Jev's uneven smile stands, and the line says so.
      if (!agree && !op.error) out.results.face_or_arm_weakness = Math.min(jev, 0.3);
      void logOpinion({ session: session ?? "pod", trait: "face_droop", stage: "smile", jev: Math.round(jev * 100) / 100, claude: v.verdict, reason: v.reason, agree, ms: op.ms, error: op.error });
      addNote(session ?? "pod", op.error ? `smile test: Jev uneven ${jev.toFixed(2)}, Claude gave no answer (${v.reason}) → stroke question on the smile test alone` : `smile test: Jev uneven ${jev.toFixed(2)}, Claude ${v.verdict} (${v.reason}) → ${agree ? "stroke question" : "not asked"}`);
      return NextResponse.json({ ...out, opinion: op });
    }
    return NextResponse.json(out);
  } catch (err) {
    console.error("test failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Test failed" }, { status: 500 });
  }
}
