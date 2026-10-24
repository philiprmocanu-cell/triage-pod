import { NextResponse } from "next/server";
import { jev, JevQuestion, noulOf } from "@/lib/jev";
import { TRAITS } from "@/lib/triage/traits";
import type { Frame } from "@/lib/triage/types";

export const runtime = "nodejs";

// Live physical scan: Jev checks every trait over the last few seconds of camera pictures, in one
// request. Runs every few seconds while someone is in front of the pod.
export async function POST(req: Request) {
  const { frames } = (await req.json()) as { frames: Frame[] };
  if (!frames?.length) return NextResponse.json({ error: "No pictures" }, { status: 400 });
  const t0 = Date.now();
  const images: Record<string, string> = {};
  const seq = frames.slice(-3).map((f, i) => {
    const ref = `scan-${t0}-${i}-5e8a`;
    images[ref] = f.b64;
    return { seconds_ago: Math.round(f.secondsAgo), picture: ref };
  });
  const q: Record<string, JevQuestion> = {
    person_visible: { type: "noul", instructions: "In the `frames`, is a person clearly visible?" },
  };
  for (const t of TRAITS) {
    q[t.id] = { type: "noul", instructions: `Look at the \`frames\` (a few seconds of camera pictures of a patient at a health post, oldest first). ${t.look}` };
  }
  try {
    const a = await jev({ setting: "Patient sitting in front of a health pod camera.", frames: seq }, q, images);
    const person = noulOf(a.person_visible);
    const traits = Object.fromEntries(TRAITS.map((t) => [t.id, person >= 0.5 ? noulOf(a[t.id]) : 0]));
    return NextResponse.json({ person, traits, ms: Date.now() - t0 });
  } catch (err) {
    console.error("scan failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Scan failed" }, { status: 500 });
  }
}
