import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { maxUrgency, runRules } from "./rules";
import { CameraSignals, Resource, TriageResult, Turn } from "./types";

const MAX_QUESTIONS = 6;

const urgency = z.enum(["green", "yellow", "red"]);

const BrainOutput = z.object({
  language: z.string().describe("ISO-639-1 code of the language the patient is speaking"),
  locale: z.string().describe("Best-guess BCP-47 regional dialect, e.g. es-MX, es-GT, es-PE, es-BO, es-CO, en-US"),
  dialect_reason: z.string().describe("Which words or phrasing suggest that region, in English"),
  patient_text: z.string().describe("The patient's latest words, cleaned up, in their own language"),
  patient_text_english: z.string(),
  findings: z.object({
    age_group: z.enum(["newborn", "child", "adult", "older_adult", "unknown"]),
    chest_pain: z.boolean(),
    pain_spreads_to_arm_jaw_or_back: z.boolean(),
    sweating_or_clammy: z.boolean(),
    short_of_breath: z.boolean(),
    slurred_or_confused_speech: z.boolean(),
    face_or_arm_weakness_reported: z.boolean(),
    sudden_onset: z.boolean(),
    seizure: z.boolean(),
    unable_to_drink_or_breastfeed: z.boolean(),
    vomits_everything: z.boolean(),
    very_sleepy_or_unconscious: z.boolean(),
    fever: z.boolean(),
    cough: z.boolean(),
    fast_breathing: z.boolean(),
    chest_indrawing: z.boolean(),
    diarrhea: z.boolean(),
    sunken_eyes_or_very_thirsty: z.boolean(),
    blood_in_stool: z.boolean(),
    severe_bleeding: z.boolean(),
    pregnant: z.boolean(),
    severe_headache_or_blurred_vision: z.boolean(),
  }),
  causes: z
    .array(z.object({ name: z.string(), probability: z.number(), why: z.string() }))
    .describe("3-5 likely causes, probabilities 0-1 summing to about 1, English"),
  urgency,
  resources: z
    .array(
      z.object({
        item: z.string(),
        probability: z.number().describe("0-1 chance this patient will need it"),
        delivery: z.enum(["on_site", "drone", "road"]),
      }),
    )
    .describe("Supplies or services this patient is likely to need, English"),
  doctor_required: z.boolean(),
  reason: z.string().describe("One sentence for the health worker, English"),
  english_summary: z.string().describe("2-3 sentence handover note for the doctor, English"),
  done: z.boolean().describe("true when another question would not change the decision"),
  next_question: z.string().nullable().describe("ONE short question in the patient's language and dialect, or null if done"),
  next_question_english: z.string().nullable(),
});

const SYSTEM = `You are the triage nurse inside a health pod at a rural health post in a low-resource region. A community health worker is present; a doctor reviews your output remotely. You do not diagnose. You decide how urgent this is, what is most likely going on, and what supplies or care the patient will need.

How to talk to the patient:
- Reply in the patient's own language and regional dialect, with their own words for symptoms. Plain, warm, short. One question at a time, under 20 words.
- Ask the question that would most change your decision: target the cause or danger sign you are least certain about. Prefer yes/no or simple choice questions.
- Never tell the patient a diagnosis. If urgent, calmly tell them help is being arranged.
- If someone answers for a child, address the caregiver.

How to decide:
- Use WHO IMCI logic for children (danger signs, fast breathing, chest indrawing, fever means test for malaria in malaria areas, dehydration signs) and standard red flags for adults (FAST stroke signs, cardiac chest pain, severe bleeding, pregnancy danger signs).
- Camera readings come from a webcam: treat them as hints, not measurements. A flagged face droop is a serious sign.
- Mark a finding true only when the patient said it or it is clearly implied. Unknown means false.
- Delivery: "on_site" for items in the health worker's kit (amoxicillin, oral rehydration salts, zinc, malaria rapid tests, paracetamol), "drone" for small items the post may lack (antimalarials, blood, antivenom, specific drugs), "road" for oxygen, transport, and anything heavy.
- Set done=true after at most ${MAX_QUESTIONS} questions, or as soon as the decision is clear. When done, next_question is a short closing instruction to the patient in their language (for example that a doctor is being contacted), not a question.

Language detection: on the first turn you may receive the same audio transcribed under several language guesses. The guess that reads as natural speech is the real language; transcripts forced into the wrong language look garbled or translated. Pick the regional locale from vocabulary and phrasing; if nothing points to a region, use the deployment default you are given.`;

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

export type BrainInput = {
  turns: Turn[];
  // Latest patient utterance: either one transcript, or several language guesses on the first turn.
  latest: { text?: string; candidates?: Record<string, string> };
  camera: CameraSignals;
  defaultLocale: string;
  region: string;
};

export async function runTriage(input: BrainInput): Promise<TriageResult> {
  const podQuestions = input.turns.filter((t) => t.role === "pod").length;

  const history = input.turns
    .map((t) => `${t.role === "pod" ? "Pod" : "Patient"}: ${t.text}${t.english ? `  [English: ${t.english}]` : ""}`)
    .join("\n");

  const latest = input.latest.candidates
    ? "Latest patient audio, transcribed under each language guess:\n" +
      Object.entries(input.latest.candidates)
        .map(([lang, text]) => `- ${lang}: ${text || "(empty)"}`)
        .join("\n")
    : `Latest patient words: ${input.latest.text ?? ""}`;

  const camera = [
    `Heart rate from face video: ${input.camera.heartRateBpm ? `${Math.round(input.camera.heartRateBpm)} bpm (confidence ${input.camera.heartRateConfidence.toFixed(2)})` : "not available yet"}`,
    `Face asymmetry: ${input.camera.droop ? `score ${input.camera.droop.score.toFixed(2)}${input.camera.droop.flagged ? `, FLAGGED on patient's ${input.camera.droop.side ?? "?"} side` : ", not flagged"}` : "no face detected"}`,
    `Smile test: ${input.camera.smileTest}`,
  ].join("\n");

  const user = `Deployment region: ${input.region}. Default dialect: ${input.defaultLocale}.
Questions asked so far: ${podQuestions} of max ${MAX_QUESTIONS}.

Conversation so far:
${history || "(none - this is the patient's first statement)"}

${latest}

Camera readings:
${camera}`;

  const response = await anthropic().beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(BrainOutput) },
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });

  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  const out = response.parsed_output;
  if (!out) throw new Error("Could not read the triage result.");

  const ruleHits = runRules(out.findings, input.camera);
  const finalUrgency = maxUrgency(out.urgency, ...ruleHits.map((h) => h.urgency));
  const redRule = ruleHits.some((h) => h.urgency === "red");

  // Rules guarantee their supplies show up even if the model missed them.
  const resources: Resource[] = [...out.resources];
  for (const hit of ruleHits) {
    for (const item of hit.resources) {
      const probability = hit.urgency === "red" ? 0.9 : 0.7;
      const existing = resources.find((r) => sameItem(r.item, item));
      if (existing) existing.probability = Math.max(existing.probability, probability);
      else resources.push({ item, probability, delivery: guessDelivery(item) });
    }
  }
  resources.sort((a, b) => b.probability - a.probability);

  const forcedDone = redRule || podQuestions >= MAX_QUESTIONS;

  return {
    language: out.language,
    locale: out.locale,
    dialect_reason: out.dialect_reason,
    patient_text: out.patient_text,
    patient_text_english: out.patient_text_english,
    done: out.done || forcedDone,
    next_question: out.next_question,
    next_question_english: out.next_question_english,
    causes: [...out.causes].sort((a, b) => b.probability - a.probability),
    urgency: finalUrgency,
    model_urgency: out.urgency,
    resources,
    doctor_required: out.doctor_required || finalUrgency !== "green",
    reason: out.reason,
    english_summary: out.english_summary,
    rule_hits: ruleHits,
    findings: out.findings,
  };
}

// "Amoxicillin" and "Amoxicillin dispersible tablets" are the same supply line.
function sameItem(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3 && w !== "with"));
  const wa = words(a), wb = words(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / Math.max(1, Math.min(wa.size, wb.size)) >= 0.6;
}

function guessDelivery(item: string): Resource["delivery"] {
  const s = item.toLowerCase();
  if (/(transport|oxygen|referral|hospital|ct|maternity)/.test(s)) return "road";
  if (/(amoxicillin|rehydration|zinc|rapid test|pulse|glucose|blood pressure|check)/.test(s)) return "on_site";
  return "drone";
}
