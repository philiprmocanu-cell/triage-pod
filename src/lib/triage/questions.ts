// Questions that repeat something the patient already said. A 1–10 score is the severity.
// "Is this the worst pain you have ever felt?" asks that again, so it is not asked.

export type TurnLike = { role: string; asks?: string | null; text: string };

const WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

export function parsePainScore(text: string): number | null {
  const t = text.toLowerCase();
  const slash = t.match(/\b(10|[0-9])\s*\/\s*10\b/);
  if (slash) return Number(slash[1]);
  const outOf = t.match(/\b(10|[0-9]|one|two|three|four|five|six|seven|eight|nine|ten)\s+out of\s+ten\b/);
  if (outOf) return WORDS[outOf[1]] ?? Number(outOf[1]);
  const digit = t.match(/\b(10|[1-9])\b/);
  if (digit) return Number(digit[1]);
  for (const [word, n] of Object.entries(WORDS)) if (new RegExp(`\\b${word}\\b`).test(t)) return n;
  return null;
}

// The number they gave when asked "from 1 to 10".
export function painScoreFromTurns(turns: TurnLike[]): number | null {
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== "pod" || turns[i].asks !== "history:severity") continue;
    const ans = turns.slice(i + 1).find((t) => t.role === "patient");
    if (ans) return parsePainScore(ans.text);
  }
  return null;
}

export type SeveritySettle = {
  score: number;
  // These findings are already answered by the score. Do not ask them again.
  known: ("severe_headache" | "worst_headache")[];
  severeYes: boolean;
  // A high score plus a sudden start is the worst-ever headache. The score alone is not.
  worstYes: boolean;
  // High score, sudden start not yet known: ask whether it started suddenly, not whether it is the worst.
  askSudden: boolean;
};

export function settleSeverity(score: number, suddenYes: boolean): SeveritySettle {
  const high = score >= 7;
  const mild = score <= 6;
  return {
    score,
    known: ["severe_headache", "worst_headache"],
    severeYes: high,
    worstYes: high && suddenYes,
    askSudden: high && !suddenYes,
  };
}

// The arm sensor is for a pulse the visit actually needs: breathing, chest, fever, or stroke.
// A connected watch does not make every visit ask for it, and a pulse already on screen is enough.
const ARM_PATHWAYS = ["breathing", "cardiac", "fever", "stroke"];

export function armReadingDue(openIds: string[], havePulse: boolean): boolean {
  if (havePulse) return false;
  return openIds.some((id) => ARM_PATHWAYS.includes(id));
}

// Six steady seconds of a visible pulse is a reading. If the arm is not there, stop at 18.
export function armHold(steadySeconds: number, elapsedSeconds: number): "read" | "done" | "give-up" {
  if (steadySeconds >= 6) return "done";
  if (elapsedSeconds >= 18) return "give-up";
  return "read";
}

// Clinical questions stop once `cap` of them have been asked. A movement the camera has to
// watch is still offered, in its place in the list, after that cap is full.
export function stepsWithinCap(steps: string[], askedClinical: number, cap: number): string[] {
  const room = askedClinical < cap;
  return steps.filter((st) => st !== "test:pulse" && (st.startsWith("test:") || room));
}
