// Claude writes the English parts a person reads: translations of what the patient said and the
// doctor's handover note. Jev makes the triage decisions (engine.ts); these calls never block them.

import Anthropic from "@anthropic-ai/sdk";
import type { Intake, TriageResult, Turn } from "./types";

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

async function ask(system: string, user: string): Promise<string> {
  const response = await anthropic().beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    system,
    messages: [{ role: "user", content: user }],
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  return response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
}

export function translate(text: string): Promise<string> {
  return ask(
    "Translate what a patient said at a rural health post into plain English for a doctor. Keep their meaning and any regional words' meaning. Reply with the translation only.",
    text,
  );
}

export function handover(turns: Turn[], result: TriageResult): Promise<string> {
  const conversation = turns.map((t) => `${t.role === "pod" ? "Pod" : "Patient"}: ${t.english ?? t.text}`).join("\n");
  const facts = {
    urgency: result.urgency,
    age_group: result.age_group,
    seen_by_camera: Object.fromEntries(Object.entries(result.seen).filter(([, v]) => (v ?? 0) >= 0.6)),
    findings: result.findings.map((f) => `${f.label}: ${Math.round(f.yes * 100)}%`),
    likely: result.causes.filter((c) => c.confident).slice(0, 3).map((c) => c.name),
    still_open: result.tree.map((p) => p.label),
    safety_rules: result.rule_hits.map((h) => `${h.label} (${h.evidence})`),
    supplies: result.resources.slice(0, 6).map((r) => r.item),
  };
  return ask(
    "Write a 3-sentence handover note for a remote doctor about a patient triaged at a village health post. Plain English, no headings. Sentence 1: who and what. Sentence 2: key findings including camera signs. Sentence 3: urgency and what is needed now. Say 'possible', never a firm diagnosis.",
    `Conversation:\n${conversation}\n\nTriage facts:\n${JSON.stringify(facts, null, 2)}`,
  );
}

// Pull a clean name, community and patient description out of the intake answers.
export async function readIntake(intake: Intake): Promise<{ name: string | null; community: string | null; patient: string | null }> {
  const text = await ask(
    'Extract from these answers given at a health post. Reply with exactly three lines: "name: ...", "community: ...", "patient: ..." (patient = who the visit is for and their age, in English, e.g. "self, 34" or "son, 3 years"). Use "unknown" when not given.',
    JSON.stringify({ name_answer: intake.name, community_answer: intake.community, who_answer: intake.who }),
  );
  const field = (k: string) => {
    const v = text.match(new RegExp(`^${k}:\\s*(.+)$`, "mi"))?.[1]?.trim();
    return v && v.toLowerCase() !== "unknown" ? v : null;
  };
  return { name: field("name"), community: field("community"), patient: field("patient") };
}

// The patient asked the pod something ("is it serious?", "what should I do?"). Answer briefly, in
// their language, without diagnosing or dosing, then the pod carries on with its next question.
export async function replyToPatient(input: {
  conversation: { speaker: string; said: string }[];
  question: string;
  language: string;
  locale: string;
  urgency: string;
  likely: string[];
}): Promise<string> {
  return ask(
    `You are the voice of a health pod at a rural health post (${input.locale}). The patient just asked you something. Answer in at most 25 words: one or two short, warm, plain sentences in their language and regional Spanish if Spanish. Never name a diagnosis as certain, never give medicine doses, never promise. You may say what the pod is checking and that the health worker and a doctor will explain and treat. If urgency is red, say calmly that help is being arranged now. Reply with the spoken words only.`,
    JSON.stringify({ patient_question: input.question, urgency: input.urgency, what_the_pod_is_considering: input.likely, recent_conversation: input.conversation.slice(-6) }),
  );
}

// For complaints the triage tree does not cover: one follow-up question a nurse would ask next.
export async function followUpQuestion(input: { conversation: Record<string, string>[]; language: string; locale: string }): Promise<{ text: string; english: string } | null> {
  const out = await ask(
    `You are the triage nurse voice of a health pod at a rural health post (${input.locale}). Read the conversation and write the ONE most useful next question a careful nurse would ask to understand this complaint better (where exactly, what makes it better or worse, other symptoms, danger signs). Never diagnose. Under 20 words, plain and warm. Reply with exactly two lines: "PATIENT: <question in the patient's language and regional Spanish if Spanish>" and "ENGLISH: <the same in English>". If enough is known already, reply "DONE".`,
    JSON.stringify({ conversation: input.conversation.slice(-10) }),
  );
  if (/^\s*DONE/i.test(out)) return null;
  const text = out.match(/PATIENT:\s*(.+)/i)?.[1]?.trim();
  const english = out.match(/ENGLISH:\s*(.+)/i)?.[1]?.trim();
  return text ? { text, english: english ?? text } : null;
}

// The coordinator agent: a short briefing of the whole pod network for the health team.
export function coordinatorBriefing(state: Record<string, unknown>): Promise<string> {
  return ask(
    "You coordinate a network of AI triage pods at rural health posts in Alta Verapaz, Guatemala. Write a 4-sentence briefing for the regional health team in plain English: what is happening (outbreaks, emergencies), what the agents already did (referrals, deliveries, doctor reviews), and the one decision a human should make now. No headings, no bullet points.",
    JSON.stringify(state),
  );
}
