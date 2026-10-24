import type { FindingKey, IntakeField, Lang, Step } from "./tree";

export type Urgency = "green" | "yellow" | "red";

export const URGENCY_RANK: Record<Urgency, number> = { green: 0, yellow: 1, red: 2 };

export type Turn = {
  role: "patient" | "pod";
  text: string; // what was said, in the patient's language
  english?: string; // translation for the doctor
  asks?: Step; // for pod turns: which finding, test or intake field this turn covers
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

export type AgeGroup = "newborn" | "child" | "adult" | "older_adult";

// Yes/no facts the rules run on. Jev's probabilities become `true` at 0.6 and above.
export type Findings = Record<FindingKey, boolean> & { age_group: AgeGroup };

export type RuleHit = {
  id: string;
  label: string; // English, for the health worker / doctor
  urgency: Urgency;
  source: "words" | "camera";
  evidence: string;
  resources: string[];
};

export type Cause = { name: string; pathway: string; probability: number; urgency: Urgency; why: string };

export type Resource = {
  item: string;
  probability: number; // chance this patient will need it, 0..1
  delivery: "on_site" | "drone" | "road";
};

export type SpeechStats = { wordsPerSecond: number; longPauses: number };

// What the camera saw at the start (Jev's look at the patient), kept for the whole visit.
export type Seen = Partial<Record<FindingKey, number>>;

export type FindingState = { key: FindingKey; label: string; yes: number; known: boolean; source: "said" | "seen" | "both" };

export type PathwayState = {
  id: string;
  label: string;
  probability: number;
  subtypes: { name: string; probability: number; urgency: Urgency }[];
};

export type Frame = { secondsAgo: number; b64: string }; // camera pictures, oldest first

export type TestResults = Partial<Record<string, Partial<Record<FindingKey, number>>>>;

export type Intake = Partial<Record<IntakeField, string>>;

export type TriageResult = {
  language: Lang;
  locale: string;
  locale_reason: string;
  age_group: AgeGroup;
  patient_text: string | null; // the transcript this turn, in the real language
  seen: Seen;
  findings: FindingState[]; // only the ones that matter (yes or asked)
  pathways: PathwayState[];
  causes: Cause[];
  urgency: Urgency;
  resources: Resource[];
  doctor_required: boolean;
  reason: string;
  rule_hits: RuleHit[];
  speech_confused: number;
  done: boolean;
  answered: Step | null; // which step the patient's latest words answered
  next: { asks: Step | null; text: string; english: string; test?: { id: string; label: string; seconds: number } } | null;
  consent: number | null; // probability the patient agreed to be saved (null = not asked yet)
  intake: Intake; // intake answers so far, including ones given before they were asked
  lexicon: Partial<Record<string, string>>; // regional words learned from this patient / community
  // The decision logic, made visible: each open pathway, why it opened, and each step's status.
  tree: {
    id: string;
    label: string;
    probability: number;
    openedBy: string[];
    steps: { step: string; label: string; status: "yes" | "no" | "unclear" | "next" | "waiting" }[];
  }[];
  why: string | null; // why the pod is asking the current question
  peer_group: { wants: boolean; category: string | null };
  jev_ms: number;
};
