// The live camera scan, as one call: Jev looks at a burst of pictures (plus face close-ups) and
// answers every trait. Used by /api/scan (the pod) and /api/judge (the stress-test harness).

import { jev, JevQuestion, noulOf } from "@/lib/jev";
import { jevWithin } from "@/lib/triage/engine";
import { TRAITS } from "@/lib/triage/traits";
import type { Frame } from "@/lib/triage/types";

// Most people who sit at a pod are well; a scan that leans "yes" on a normal face sends the pod
// asking about problems that aren't there.
export const CALIBRATE =
  "Look at the `frames` (a few seconds of camera pictures of a person at a health post, oldest first; each has the whole picture and, when present, a `face_closeup` of the same moment: use the close-up for anything about the face, eyes, lips or skin, the whole picture for posture, hands and who is there). Most people here are healthy, and a calm, neutral, tired or bored face is normal: answer no unless the sign is clearly there.";
// Face droop keeps a bare wording (no "assume healthy" lead-in): the stress test (docs/CAMERA.md)
// showed the stricter wording below drops the one true palsy photo from 0.59 to 0.43 (under the
// 0.45 hunch threshold) while the healthy set produced no face-droop alarm either way. What stops
// a false stroke question is not the wording but what follows: three bursts, even light, the
// smile test, and Claude's second opinion on the smile.
export const LOOK_ONLY = "Look at the `frames` (camera pictures of a person at a health post, oldest first; each may have a `face_closeup` of the same moment: use it for the face).";
export const STRICT_DROOP_EXTRA =
  " A hand, glasses, a mask, a tilted head, a smirk, uneven light or a shadow on one side is NOT a droop: answer no unless the mouth is fully visible and one corner clearly sags while the other does not.";
export const FACE_CLEAR = 0.6; // below this, face, eye and skin traits aren't judged
export const BODY_CLEAR = 0.6; // below this, posture and "who is here" traits aren't judged
export const BODY_GROUPS = new Set(["Pain & posture", "Who is here"]); // judged from the whole picture, face or not

export type ScanRaw = {
  person: number;
  face: number;
  body: number;
  answers: Record<string, number>; // every trait, before the face/body gates
  ms: number;
};

export type ScanOptions = { timeoutMs?: number; strictDroop?: boolean /* experiment: the stricter face-droop wording */ };

export async function jevScan(frames: Frame[], opts: ScanOptions = {}): Promise<ScanRaw> {
  const t0 = Date.now();
  const images: Record<string, string> = {};
  const seq = frames.slice(-10).map((f, i) => {
    const ref = `scan-${t0}-${i}-5e8a`;
    images[ref] = f.b64;
    if (f.face) images[`${ref}-face`] = f.face;
    return { seconds_ago: Math.round(f.secondsAgo), picture: ref, ...(f.face && { face_closeup: `${ref}-face` }) };
  });
  const q: Record<string, JevQuestion> = {
    person_visible: { type: "noul", instructions: "In the `frames`, is a person clearly visible?" },
    face_clear: {
      type: "noul",
      instructions: "In the `frames`, is one person's face close to the camera and facing it: the face fills a good part of the picture (at least a fifth of its height), both eyes are visible, and it is lit well enough to judge skin colour? Someone far away, at the edge, side-on or in the background counts as no.",
    },
    body_clear: {
      type: "noul",
      instructions: "In the `frames`, is the main person close enough that their posture, hands and upper body are clearly visible (they fill at least a third of the picture's height)? A small figure far away counts as no.",
    },
  };
  for (const t of TRAITS) {
    const droop = t.id === "face_droop";
    // Face droop always uses the strict wording. The score is shown to the operator and then
    // discarded: a resting face does not open a question. opts.strictDroop remains for the harness.
    q[t.id] = {
      type: "noul",
      instructions:
        t.id === "sweaty"
          ? `${LOOK_ONLY} ${t.look}`
          : droop
            ? `${CALIBRATE} ${t.look}${opts.strictDroop === false ? "" : STRICT_DROOP_EXTRA}`
            : `${CALIBRATE} ${t.look}`,
    };
  }
  const a = await jevWithin(`scan, ${seq.length} frames`, jev({ setting: "Patient sitting in front of a health pod camera.", frames: seq }, q, images), opts.timeoutMs ?? 20_000);
  return {
    person: noulOf(a.person_visible),
    face: noulOf(a.face_clear),
    body: noulOf(a.body_clear),
    answers: Object.fromEntries(TRAITS.map((t) => [t.id, noulOf(a[t.id])])),
    ms: Date.now() - t0,
  };
}

// The face/body gates: a trait is only a score when the part of the body it needs was clearly seen.
export function gateByView(raw: ScanRaw): { judged: boolean; bodyJudged: boolean; traits: Record<string, number> } {
  const judged = raw.person >= 0.5 && raw.face >= FACE_CLEAR;
  const bodyJudged = raw.person >= 0.5 && raw.body >= BODY_CLEAR;
  const traits = Object.fromEntries(TRAITS.map((t) => [t.id, (BODY_GROUPS.has(t.group) ? bodyJudged : judged) ? raw.answers[t.id] : 0]));
  return { judged, bodyJudged, traits };
}
