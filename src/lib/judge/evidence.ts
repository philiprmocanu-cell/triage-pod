// Evidence rules for the high-stakes signs (stroke, heart, breathing): one burst is never enough.
// A sign has to be there in three bursts in a row, with the face clearly seen and evenly lit, and
// Claude has to agree on the same pictures, before the pod says a word about it. Everything the
// camera thinks it saw and why it was (not) acted on is written as a plain line for the operator.

import { TRAITS } from "@/lib/triage/traits";
import type { Lighting } from "./lighting";
import { LIGHT_ASYM_MAX } from "./lighting";
import type { Verdict } from "./opinion";

export type Risk = "stroke" | "heart" | "breathing";
// Face droop is not judged by Claude on the resting face (it read a textbook palsy photo as a
// "deliberate grimace"): it goes to the smile test, and Claude judges the smile pictures instead.
export const SMILE_CONFIRMS = new Set(["face_droop"]);
// `face`: judged on the face close-up, so it needs a clear, evenly lit face. Body signs need the body in view.
export const HIGH_STAKES: Record<string, { risk: Risk; face: boolean }> = {
  face_droop: { risk: "stroke", face: true },
  slack_mouth: { risk: "stroke", face: true },
  gaze_off: { risk: "stroke", face: true },
  confused_look: { risk: "stroke", face: true },
  limp_arm: { risk: "stroke", face: false },
  holding_head: { risk: "stroke", face: false }, // a hand on the chin reads as "holding the head" (owner's kiosk photo, 6/7 variants)
  holding_chest: { risk: "heart", face: false },
  labored: { risk: "breathing", face: true },
  nostril_flare: { risk: "breathing", face: true },
  fast_chest: { risk: "breathing", face: true },
  mouth_breathing: { risk: "breathing", face: true },
  blue_lips: { risk: "breathing", face: true },
};

export const NEEDED_BURSTS = 3; // consecutive bursts a high-stakes sign must persist across
export const FACE_CLEAR_STRICT = 0.8; // face_clear needed on each of those bursts for face signs
export const BODY_CLEAR_STRICT = 0.6;
export const VERDICT_TTL_MS = 90_000; // a Claude verdict holds this long for the same sign
export const BURST_TTL_MS = 40_000; // bursts older than this are forgotten (the person left)
export const MAX_BURSTS = 8;

// Below this a sign is "seen" in a burst (the hunch thresholds the engine uses on smoothed scores).
export const hunchThreshold = (traitId: string) => (traitId === "face_droop" ? 0.45 : 0.6);
export const SHOW_FROM = 0.3; // raw score from which the operator line shows the sign at all

export type Burst = { at: number; face: number; body: number; lighting: Lighting | null; raw: Record<string, number> };
export type Evidence = {
  trait: string;
  label: string;
  raw: number; // latest burst
  streak: number; // consecutive bursts at or above the hunch threshold
  needed: number;
  persisted: boolean; // streak reached and every burst in it had a clear, evenly lit view
  blocker: string | null; // why the streak doesn't count (face not clear, uneven light, body not in view)
  verdict: Verdict | null; // Claude's second opinion, when it was asked
  passed: boolean; // the sign may reach the engine
  line: string; // what the operator reads
};

type Session = { bursts: Burst[]; verdicts: Map<string, { verdict: Verdict; at: number }>; lastEvidence: Evidence[]; lastAt: number; notes: { line: string; at: number }[] };
export const NOTE_TTL_MS = 60_000;
// One memory for the whole server process: /api/scan, /api/judge and /api/test are bundled
// separately by Next, each with its own copy of this module, so a plain module variable would
// give every route a different notebook. globalThis is shared.
const g = globalThis as unknown as { __triageJudgeSessions?: Map<string, Session> };
const sessions = (g.__triageJudgeSessions ??= new Map<string, Session>());

export function session(id = "pod"): Session {
  let s = sessions.get(id);
  if (!s) sessions.set(id, (s = { bursts: [], verdicts: new Map(), lastEvidence: [], lastAt: 0, notes: [] }));
  return s;
}
export function resetSession(id = "pod") {
  sessions.delete(id);
}

export function recordBurst(id: string, burst: Burst) {
  const s = session(id);
  s.bursts = [...s.bursts.filter((b) => burst.at - b.at < BURST_TTL_MS), burst].slice(-MAX_BURSTS);
  s.lastAt = burst.at;
}

// Streak and blockers for one sign, from the newest burst backwards.
export function assess(id: string, trait: string): Evidence {
  const s = session(id);
  const def = HIGH_STAKES[trait];
  const label = TRAITS.find((t) => t.id === trait)?.label.toLowerCase() ?? trait;
  const latest = s.bursts[s.bursts.length - 1];
  const raw = latest?.raw[trait] ?? 0;
  const th = hunchThreshold(trait);
  let streak = 0;
  let blocker: string | null = null;
  for (let i = s.bursts.length - 1; i >= 0; i--) {
    const b = s.bursts[i];
    if ((b.raw[trait] ?? 0) < th) break;
    streak++;
    if (streak > NEEDED_BURSTS) continue;
    if (def.face) {
      if (b.face < FACE_CLEAR_STRICT) blocker ??= `face not clear enough (${pct(b.face)} < ${pct(FACE_CLEAR_STRICT)})`;
      else if (!b.lighting) blocker ??= "no face close-up in this burst";
      else if (b.lighting.asym > LIGHT_ASYM_MAX) blocker ??= `uneven light (${b.lighting.left > b.lighting.right ? "left" : "right"} side ${pct(b.lighting.asym)} brighter)`;
    } else if (b.body < BODY_CLEAR_STRICT) blocker ??= `body not clearly in view (${pct(b.body)})`;
  }
  const persisted = streak >= NEEDED_BURSTS && !blocker;
  const cached = s.verdicts.get(trait);
  const verdict = cached && Date.now() - cached.at < VERDICT_TTL_MS ? cached.verdict : null;
  const passed = persisted && (SMILE_CONFIRMS.has(trait) || verdict?.verdict === "yes");
  const n = `${streak} burst${streak === 1 ? "" : "s"}`;
  let line: string;
  if (raw < SHOW_FROM && streak === 0) line = "";
  else if (streak < NEEDED_BURSTS) line = `${label} ${raw.toFixed(2)} × ${n} — not asked (needs ${NEEDED_BURSTS})`;
  else if (blocker) line = `${label} ${raw.toFixed(2)} × ${n} — not asked: ${blocker}`;
  else if (SMILE_CONFIRMS.has(trait)) line = `${label} ${raw.toFixed(2)} × ${n} — smile test next (Claude checks the smile before any question)`;
  else if (!verdict) line = `${label} ${raw.toFixed(2)} × ${n} — asking Claude for a second opinion…`;
  else if (verdict.verdict === "yes") line = `${label} ${raw.toFixed(2)} × ${n} — Claude agrees (${verdict.reason}) → ${trait === "face_droop" ? "smile test next" : "will ask"}`;
  else line = `${label} ${raw.toFixed(2)} × ${n} — Claude says ${verdict.verdict} (${verdict.reason}) → not asked`;
  return { trait, label, raw, streak, needed: NEEDED_BURSTS, persisted, blocker, verdict, passed, line };
}

export function rememberVerdict(id: string, trait: string, verdict: Verdict) {
  session(id).verdicts.set(trait, { verdict, at: Date.now() });
}
export function cachedVerdict(id: string, trait: string): Verdict | null {
  const c = session(id).verdicts.get(trait);
  return c && Date.now() - c.at < VERDICT_TTL_MS ? c.verdict : null;
}
export function setEvidence(id: string, ev: Evidence[]) {
  session(id).lastEvidence = ev;
}
// A line from outside the scan loop (the smile test's verdict), shown for a minute.
export function addNote(id: string, line: string) {
  const s = session(id);
  s.notes = [...s.notes.filter((n) => Date.now() - n.at < NOTE_TTL_MS), { line, at: Date.now() }];
  s.lastAt = Math.max(s.lastAt, Date.now());
}
export function lastEvidence(id = "pod"): { at: number; evidence: Evidence[]; notes: string[]; lighting: Lighting | null; face: number } {
  const s = session(id);
  const latest = s.bursts[s.bursts.length - 1];
  return { at: s.lastAt, evidence: s.lastEvidence, notes: s.notes.filter((n) => Date.now() - n.at < NOTE_TTL_MS).map((n) => n.line), lighting: latest?.lighting ?? null, face: latest?.face ?? 0 };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
