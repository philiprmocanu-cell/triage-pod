// Claude writes the English parts a person reads: translations of what the patient said and the
// doctor's handover note. Jev makes the triage decisions (engine.ts); these calls never block them.

import Anthropic from "@anthropic-ai/sdk";
import type { TriageResult, Turn } from "./types";

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
    likely: result.causes.slice(0, 4).map((c) => `${c.name} ${Math.round(c.probability * 100)}%`),
    safety_rules: result.rule_hits.map((h) => `${h.label} (${h.evidence})`),
    supplies: result.resources.slice(0, 6).map((r) => r.item),
  };
  return ask(
    "Write a 3-sentence handover note for a remote doctor about a patient triaged at a village health post. Plain English, no headings. Sentence 1: who and what. Sentence 2: key findings including camera signs. Sentence 3: urgency and what is needed now. Say 'possible', never a firm diagnosis.",
    `Conversation:\n${conversation}\n\nTriage facts:\n${JSON.stringify(facts, null, 2)}`,
  );
}
