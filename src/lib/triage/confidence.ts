// The percent on the pod screen, taken from Jev's own choice probability.
//
// Jev returns a distribution over the conditions in one area (plus "not sure yet").
// That number is what the screen shows once the patient has said a trigger for the area.
// A vague complaint that only partly fits the area scales the number down, so a weak
// "maybe chest" cannot display a strong heart-attack percent.
// How many questions have been asked does not shrink the percent. It only decides
// whether the pod is willing to name the condition and order anything.

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function conditionProbability(jev: number, area: number, saidTrigger: boolean): number {
  const p = clamp01(jev);
  if (p < 0.02) return 0;
  const weight = saidTrigger ? 1 : clamp01(area);
  return Math.round(p * weight * 1000) / 1000;
}

// What the screen used to show: area × Jev × a discount for "not enough questions yet".
// A 74% heart attack became ~20% after one answer. Kept so the check script can compare.
export function legacyProbability(jev: number, area: number, questionsAnswered: number): number {
  const discount = Math.min(1, 0.35 + 0.15 * questionsAnswered);
  return Math.round(clamp01(area) * clamp01(jev) * discount * 1000) / 1000;
}

export type ProbabilityCase = {
  name: string;
  said: string;
  condition: string;
  jev: number;
  area: number;
  saidTrigger: boolean;
  questionsAnswered: number;
};

// Spoken complaints, with the kind of choice probabilities Jev returns for that area.
// These are the figures the check script prints. They are not a live Jev call.
export const PROBABILITY_CASES: ProbabilityCase[] = [
  {
    name: "Chest pain with spread and sweat",
    said: "My chest hurts, the pain goes into my jaw, and I am sweating.",
    condition: "Heart attack",
    jev: 0.74,
    area: 0.92,
    saidTrigger: true,
    questionsAnswered: 3,
  },
  {
    name: "Chest pain, early, one answer",
    said: "I have pressure in my chest.",
    condition: "Heart attack",
    jev: 0.41,
    area: 0.88,
    saidTrigger: true,
    questionsAnswered: 1,
  },
  {
    name: "Chest pain that sounds muscular",
    said: "My chest hurts when I press it, after I lifted a sack. No sweating, I can breathe.",
    condition: "Muscle or reflux pain",
    jev: 0.71,
    area: 0.9,
    saidTrigger: true,
    questionsAnswered: 4,
  },
  {
    name: "Vague 'I feel unwell', Jev only leans chest",
    said: "I do not feel well.",
    condition: "Heart attack",
    jev: 0.4,
    area: 0.22,
    saidTrigger: false,
    questionsAnswered: 0,
  },
  {
    name: "Cough for two days, no danger signs",
    said: "I have had a cough for two days. I am not short of breath.",
    condition: "Common cold",
    jev: 0.66,
    area: 0.9,
    saidTrigger: true,
    questionsAnswered: 2,
  },
  {
    name: "Fever and chills in a malaria area",
    said: "I have been hot, then shivering, then sweating, for three days.",
    condition: "Malaria",
    jev: 0.58,
    area: 0.93,
    saidTrigger: true,
    questionsAnswered: 2,
  },
  {
    name: "Healthy person sitting still, no complaint",
    said: "(nothing said yet — a face in frame is not a symptom)",
    condition: "Stroke",
    jev: 0.14,
    area: 0,
    saidTrigger: false,
    questionsAnswered: 0,
  },
];
