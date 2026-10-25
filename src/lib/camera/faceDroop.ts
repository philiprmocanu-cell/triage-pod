// Face droop (the "F" in the FAST stroke check). Two measurements from MediaPipe's face mesh:
//  1. Resting geometry: is one mouth corner lower than the other, measured relative to the line
//     between the eyes so head tilt doesn't count.
//  2. Smile test: when the patient smiles, does one side of the mouth move much less?

import type { Category, NormalizedLandmark } from "@mediapipe/tasks-vision";

// Mesh indices. "Right"/"left" are the patient's own sides.
const EYE_OUTER_RIGHT = 33;
const EYE_OUTER_LEFT = 263;
const MOUTH_RIGHT = 61;
const MOUTH_LEFT = 291;

const GEO_THRESHOLD = 0.07; // corner height difference / eye distance
const SMILE_ASYM_THRESHOLD = 0.35;

export type DroopFrame = { geo: number; side: "left" | "right" | null; smileL: number; smileR: number };

export function measureFrame(lm: NormalizedLandmark[], blend: Category[] | undefined): DroopFrame {
  const er = lm[EYE_OUTER_RIGHT], el = lm[EYE_OUTER_LEFT];
  const ex = el.x - er.x, ey = el.y - er.y;
  const eyeDist = Math.hypot(ex, ey) || 1e-6;
  // Distance of each mouth corner below the eye line (perpendicular), normalised by eye distance.
  const below = (p: NormalizedLandmark) => ((p.x - er.x) * -ey + (p.y - er.y) * ex) / eyeDist / eyeDist;
  const dRight = below(lm[MOUTH_RIGHT]);
  const dLeft = below(lm[MOUTH_LEFT]);
  const diff = dRight - dLeft; // positive: right corner sits lower
  const geo = Math.abs(diff);
  const score = (name: string) => blend?.find((c) => c.categoryName === name)?.score ?? 0;
  return {
    geo,
    side: geo < 0.02 ? null : diff > 0 ? "right" : "left",
    smileL: score("mouthSmileLeft"),
    smileR: score("mouthSmileRight"),
  };
}

export class DroopTracker {
  private ema = 0;
  private lastSide: "left" | "right" | null = null;
  private smileFrames: number[] = [];
  private smiling = false;

  reset() {
    this.ema = 0;
    this.lastSide = null;
    this.smileFrames = [];
    this.smiling = false;
  }

  push(f: DroopFrame) {
    this.ema = this.ema * 0.9 + f.geo * 0.1;
    // A resting mouth corner is not a droop. A hand, a tilt, or a shadow used to latch this
    // for the whole visit and the pod then asked about a stroke. Only the smile test speaks.
    if (f.side && this.smiling) this.lastSide = f.side;
    if (this.smiling && f.smileL + f.smileR > 0.6) {
      this.smileFrames.push(Math.abs(f.smileL - f.smileR) / (f.smileL + f.smileR));
    }
  }

  startSmileTest() {
    this.smileFrames = [];
    this.smiling = true;
  }

  // Returns null if the patient never actually smiled.
  finishSmileTest(): "normal" | "asymmetric" | null {
    this.smiling = false;
    if (this.smileFrames.length < 10) return null;
    const avg = this.smileFrames.reduce((a, b) => a + b, 0) / this.smileFrames.length;
    return avg > SMILE_ASYM_THRESHOLD ? "asymmetric" : "normal";
  }

  state() {
    return {
      score: Math.min(1, this.ema / (GEO_THRESHOLD * 1.5)),
      side: this.lastSide,
      flagged: false,
    };
  }
}
