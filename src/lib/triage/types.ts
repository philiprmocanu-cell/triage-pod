export type Urgency = "green" | "yellow" | "red";

export const URGENCY_RANK: Record<Urgency, number> = { green: 0, yellow: 1, red: 2 };

export type Turn = {
  role: "patient" | "pod";
  text: string; // what was said, in the patient's language
  english?: string; // translation for the doctor
};

export type CameraSignals = {
  heartRateBpm: number | null;
  heartRateConfidence: number; // 0..1
  droop: {
    score: number; // 0..1, higher = more one-sided
    side: "left" | "right" | null; // patient's own left/right
    flagged: boolean; // sustained asymmetry above threshold
  } | null;
  smileTest: "not_done" | "normal" | "asymmetric";
};

// Facts the AI extracts from the conversation. Code, not the AI, turns these into danger levels.
export type Findings = {
  age_group: "newborn" | "child" | "adult" | "older_adult" | "unknown";
  chest_pain: boolean;
  pain_spreads_to_arm_jaw_or_back: boolean;
  sweating_or_clammy: boolean;
  short_of_breath: boolean;
  slurred_or_confused_speech: boolean;
  face_or_arm_weakness_reported: boolean;
  sudden_onset: boolean;
  seizure: boolean;
  unable_to_drink_or_breastfeed: boolean;
  vomits_everything: boolean;
  very_sleepy_or_unconscious: boolean;
  fever: boolean;
  cough: boolean;
  fast_breathing: boolean;
  chest_indrawing: boolean;
  diarrhea: boolean;
  sunken_eyes_or_very_thirsty: boolean;
  blood_in_stool: boolean;
  severe_bleeding: boolean;
  pregnant: boolean;
  severe_headache_or_blurred_vision: boolean;
};

export type RuleHit = {
  id: string;
  label: string; // English, for the health worker / doctor
  urgency: Urgency;
  source: "words" | "camera";
  evidence: string;
  resources: string[];
};

export type Cause = { name: string; probability: number; why: string };

export type Resource = {
  item: string;
  probability: number; // chance this patient will need it, 0..1
  delivery: "on_site" | "drone" | "road";
};

export type TriageResult = {
  language: string; // ISO-639-1, e.g. "es"
  locale: string; // BCP-47 dialect, e.g. "es-MX"
  dialect_reason: string;
  patient_text: string; // the cleaned-up patient utterance this turn
  patient_text_english: string;
  done: boolean;
  next_question: string | null; // in the patient's language/dialect
  next_question_english: string | null;
  causes: Cause[];
  urgency: Urgency;
  model_urgency: Urgency;
  resources: Resource[];
  doctor_required: boolean;
  reason: string;
  english_summary: string;
  rule_hits: RuleHit[];
  findings: Findings;
};
