import { NextResponse } from "next/server";
import { HIGH_STAKES, hunchThreshold, resetSession, session } from "@/lib/judge/evidence";
import { secondOpinion } from "@/lib/judge/opinion";
import { scanBurst } from "@/lib/judge/pipeline";
import { TRAITS } from "@/lib/triage/traits";
import type { Frame } from "@/lib/triage/types";

export const runtime = "nodejs";
export const maxDuration = 120;

// Stress-test harness (docs/CAMERA.md): run one burst exactly as the pod does, under a named
// session so persistence can be exercised, and optionally have Claude judge every trait Jev
// leaned towards (score ≥ 0.3) plus the traits the test photo is known to show.
//   { frames, session, strict?: true, reset?: true, opinion?: "none" | "all", expect?: string[] }
export async function POST(req: Request) {
  const body = (await req.json()) as { frames: Frame[]; session?: string; strict?: boolean; reset?: boolean; opinion?: "none" | "all"; expect?: string[] };
  const sid = body.session ?? "harness";
  if (body.reset) resetSession(sid);
  if (!body.frames?.length) return NextResponse.json({ error: "No pictures" }, { status: 400 });
  try {
    const r = await scanBurst(body.frames, sid, { strictDroop: body.strict, opinionTimeoutMs: 30_000 });
    // What the pod before the fix would have done with this burst: a hunch fires once the smoothed
    // score (0.5 × previous + 0.5 × now, three identical bursts) reaches the hunch threshold, so
    // raw ≥ 0.875 × threshold on one burst is enough.
    const oldPolicy = Object.fromEntries(TRAITS.filter((t) => (r.viewed[t.id] ?? 0) >= hunchThreshold(t.id) / 0.875).map((t) => [t.id, r.viewed[t.id]]));
    let claude = null;
    if (body.opinion === "all") {
      const ids = TRAITS.filter((t) => (r.viewed[t.id] ?? 0) >= 0.3 || body.expect?.includes(t.id)).map((t) => t.id);
      claude = ids.length ? await secondOpinion(body.frames, ids, { timeoutMs: 60_000 }) : null;
    }
    return NextResponse.json({
      session: sid,
      person: r.raw.person,
      face: r.raw.face,
      body: r.raw.body,
      judged: r.judged,
      bodyJudged: r.bodyJudged,
      lighting: r.lighting,
      answers: r.raw.answers, // every trait, no gates
      viewed: r.viewed, // after the face/body view gates (what reached the engine before the fix)
      traits: r.traits, // what reaches the engine now
      oldPolicy, // traits the old pod would have asked about from bursts like this one
      highStakes: Object.keys(HIGH_STAKES),
      evidence: r.evidence,
      bursts: session(sid).bursts.map((b) => ({ at: b.at, face: b.face, body: b.body, asym: b.lighting?.asym ?? null, high: Object.fromEntries(Object.keys(HIGH_STAKES).map((t) => [t, Math.round((b.raw[t] ?? 0) * 100) / 100])) })),
      opinion: r.opinion, // the live second opinion, when the gate reached it
      claude, // the harness's full second opinion
      jevMs: r.raw.ms,
      ms: r.ms,
    });
  } catch (err) {
    console.error("judge failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Judge failed" }, { status: 500 });
  }
}
