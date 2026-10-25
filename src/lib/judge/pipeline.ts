// One camera burst, end to end, exactly as the pod runs it: Jev scores every trait, the view gates
// apply, the burst is remembered, and the high-stakes signs (stroke, heart, breathing) only pass
// when they persisted over three bursts, the face was clear and evenly lit, and Claude agreed on
// the same pictures. /api/scan (the pod) and /api/judge (the stress test) both call this.

import type { Frame } from "@/lib/triage/types";
import { assess, cachedVerdict, Evidence, HIGH_STAKES, hunchThreshold, misses, noteMiss, recordBurst, rememberVerdict, setEvidence, SMILE_CONFIRMS } from "./evidence";
import { faceLighting, Lighting } from "./lighting";
import { hasOpinion, logOpinion, Opinion, opinionDown, secondOpinion } from "./opinion";
import { gateByView, jevScan, ScanOptions, ScanRaw } from "./scan";

export const OPINION_TIMEOUT_MS = 3000; // the live pod waits at most this long for the second opinion

export type BurstResult = {
  raw: ScanRaw;
  judged: boolean;
  bodyJudged: boolean;
  viewed: Record<string, number>; // after the face/body view gates, before the high-stakes rules
  traits: Record<string, number>; // what the engine gets
  lighting: Lighting | null;
  evidence: Evidence[];
  opinion: Opinion | null;
  ms: number;
};

export async function scanBurst(frames: Frame[], sid = "pod", opts: ScanOptions & { opinionTimeoutMs?: number } = {}): Promise<BurstResult> {
  const t0 = Date.now();
  const closeup = [...frames].reverse().find((f) => f.face)?.face;
  const [raw, lighting] = await Promise.all([jevScan(frames, opts), closeup ? faceLighting(closeup) : Promise.resolve(null)]);
  const { judged, bodyJudged, traits: viewed } = gateByView(raw);
  const traits = { ...viewed };
  recordBurst(sid, { at: Date.now(), face: raw.face, body: raw.body, lighting, raw: viewed });

  // High-stakes signs: persistence first, then one second opinion on the same pictures.
  const toJudge = Object.keys(HIGH_STAKES).filter((t) => {
    if (SMILE_CONFIRMS.has(t)) return false; // face droop: the smile test is the check, Claude judges the smile (/api/test)
    const ev = assess(sid, t);
    return ev.persisted && !cachedVerdict(sid, t);
  });
  let opinion: Opinion | null = null;
  if (toJudge.length && hasOpinion()) {
    opinion = await secondOpinion(frames, toJudge, { timeoutMs: opts.opinionTimeoutMs ?? OPINION_TIMEOUT_MS });
    for (const t of toJudge) {
      const v = opinion.verdicts[t];
      if (!opinion.error) rememberVerdict(sid, t, v);
      else noteMiss(sid, t); // a timeout is not a verdict: try again next burst
      void logOpinion({ session: sid, trait: t, jev: Math.round(viewed[t] * 100) / 100, claude: v.verdict, reason: v.reason, agree: v.verdict === "yes", ms: opinion.ms, error: opinion.error });
    }
  }
  // No second opinion to be had (no key, key at its usage cap, API down, or no answer within the
  // wait): that is not a "no". A heart attack must not go unasked because a monthly cap was hit, so
  // persistence (at the stricter bar), the clear view and the smile test guard the question alone,
  // and the line says so.
  const down = !process.env.ANTHROPIC_API_KEY ? "no Anthropic key" : opinionDown();
  const evidence: Evidence[] = [];
  for (const t of Object.keys(HIGH_STAKES)) {
    const ev = assess(sid, t);
      // Unanswered: Claude is unavailable, or was too slow on two bursts in a row (one slow answer just
    // waits a burst). Then the sign has to be strong on every burst (the old single-burst bar), not
    // merely present: without a second opinion the camera alone sets the bar higher.
    const unanswered = !SMILE_CONFIRMS.has(t) && ev.strong && !ev.verdict && (Boolean(down) || misses(sid, t) >= 2);
    const passed = ev.persisted && (SMILE_CONFIRMS.has(t) || ev.verdict?.verdict === "yes" || unanswered);
    const line = unanswered
      ? `${ev.label} ${ev.raw.toFixed(2)} × ${ev.streak} bursts — Claude ${down ?? "gave no answer in time, twice"}: asked on persistence alone`
      : ev.persisted && !ev.strong && !ev.verdict && !SMILE_CONFIRMS.has(t) && down
        ? `${ev.label} ${ev.raw.toFixed(2)} × ${ev.streak} bursts — not asked: Claude ${down}, and the sign is not strong enough (needs ${(hunchThreshold(t) / 0.875).toFixed(2)} on every burst) to ask without a second opinion`
        : ev.line;
    traits[t] = passed ? viewed[t] : 0;
    if (line) evidence.push({ ...ev, passed, line });
  }
  setEvidence(sid, evidence);
  return { raw, judged, bodyJudged, viewed, traits, lighting, evidence, opinion, ms: Date.now() - t0 };
}
