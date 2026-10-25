// One camera burst, end to end, exactly as the pod runs it: Jev scores every trait, the view gates
// apply, the burst is remembered, and the high-stakes signs (stroke, heart, breathing) only pass
// when they persisted over three bursts, the face was clear and evenly lit, and Claude agreed on
// the same pictures. /api/scan (the pod) and /api/judge (the stress test) both call this.

import type { Frame } from "@/lib/triage/types";
import { assess, cachedVerdict, Evidence, HIGH_STAKES, recordBurst, rememberVerdict, setEvidence, SMILE_CONFIRMS } from "./evidence";
import { faceLighting, Lighting } from "./lighting";
import { hasOpinion, logOpinion, Opinion, secondOpinion } from "./opinion";
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
      if (!opinion.error) rememberVerdict(sid, t, v); // a timeout is not a verdict: try again next burst
      void logOpinion({ session: sid, trait: t, jev: Math.round(viewed[t] * 100) / 100, claude: v.verdict, reason: v.reason, agree: v.verdict === "yes", ms: opinion.ms, error: opinion.error });
    }
  }
  const evidence: Evidence[] = [];
  for (const t of Object.keys(HIGH_STAKES)) {
    const ev = assess(sid, t);
    // Without an Anthropic key there is no second opinion: persistence and the smile test still guard the question.
    const passed = ev.persisted && (SMILE_CONFIRMS.has(t) || ev.verdict?.verdict === "yes" || !hasOpinion());
    traits[t] = passed ? viewed[t] : 0;
    if (ev.line) evidence.push({ ...ev, passed });
  }
  setEvidence(sid, evidence);
  return { raw, judged, bodyJudged, viewed, traits, lighting, evidence, opinion, ms: Date.now() - t0 };
}
