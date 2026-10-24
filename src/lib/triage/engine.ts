// One triage step, driven by Jev. A visit runs:
//  look   -> Jev watches a few seconds of camera pictures for every visible sign.
//  intake -> name, community, who the patient is, consent to be saved (skipped in an emergency).
//  open   -> "what is bothering you?"
//  then   -> pathway questions and physical tests, chosen from what was seen and said.
// After every answer Jev re-reads the whole conversation plus the pictures taken while the patient
// was talking, and answers every finding, pathway and sub-classification in one request.
// Code then opens pathways, picks the next step, applies the safety rules and adds up supplies.

import { jev, JevQuestion, noulOf, probsOf } from "../jev";
import { maxUrgency, runRules } from "./rules";
import {
  CLOSING,
  CLOSING_SUICIDE_RISK,
  FINDING_KEYS,
  FINDINGS,
  FindingKey,
  INTAKE,
  INTAKE_FIELDS,
  Lang,
  LOCALES,
  OPENING,
  PATHWAYS,
  SEEN_OPENER_ASKS,
  SEEN_OPENERS,
  Step,
  TESTS,
} from "./tree";
import type {
  AgeGroup,
  CameraSignals,
  Cause,
  Findings,
  FindingState,
  Frame,
  Intake,
  PathwayState,
  Resource,
  Seen,
  SpeechStats,
  TestResults,
  TriageResult,
  Turn,
  Urgency,
} from "./types";

const MAX_STEPS = 8; // medical questions + tests after the opening question
const MAX_FRAMES = 6;
const YES = 0.6; // probability at which a finding counts as present
const OPEN = 0.3; // probability at which a pathway is explored

// Signs that mean: skip the paperwork, start helping.
const EMERGENCY_SEEN: FindingKey[] = ["severe_bleeding", "short_of_breath", "face_or_arm_weakness", "blue_lips", "very_sleepy"];

export type StepInput = {
  stage: "look" | "answer";
  turns: Turn[]; // conversation so far, not including `latest`
  latest?: { text?: string; candidates?: Record<string, string>; speech?: SpeechStats };
  frames?: Frame[]; // pictures taken while the patient was talking, oldest first
  seen: Seen; // what the camera has seen so far this visit
  tests: TestResults;
  intake: Intake;
  camera: CameraSignals;
  language: Lang | null;
  region: string;
  defaultLocale: string;
};

const visible = FINDING_KEYS.filter((k) => "seen" in FINDINGS[k]);

export async function step(input: StepInput): Promise<TriageResult> {
  const t0 = Date.now();

  // Pick the real language on the first spoken turn.
  let language: Lang = input.language ?? (input.defaultLocale.startsWith("en") ? "en" : "es");
  let patientText = input.latest?.text ?? null;
  if (input.latest?.candidates) {
    const entries = Object.entries(input.latest.candidates).filter(([, t]) => t);
    if (entries.length > 1) {
      const a = await jev(
        { transcripts: Object.fromEntries(entries) },
        {
          lang: {
            type: "choice",
            instructions: "The same recording was transcribed under several language guesses. Which transcript reads as natural, coherent speech (the others look garbled or translated)?",
            criteria: Object.fromEntries(entries.map(([l]) => [l, null])),
          },
        },
      );
      const pick = a.lang?.type === "choice" ? a.lang.choice : entries[0][0];
      language = (pick === "en" ? "en" : "es") as Lang;
      patientText = input.latest.candidates[pick] ?? entries[0][1];
    } else if (entries.length === 1) {
      language = (entries[0][0] === "en" ? "en" : "es") as Lang;
      patientText = entries[0][1];
    }
  }

  const lastPod = [...input.turns].reverse().find((t) => t.role === "pod");
  const answered: Step | null = patientText ? (lastPod?.asks ?? null) : null;
  const intake: Intake = { ...input.intake };
  if (answered?.startsWith("intake:") && patientText) intake[answered.slice(7) as keyof Intake] = patientText;

  // Pair each pod question with the answer to it, so a bare "No" is read against its question.
  const conversation: Record<string, string>[] = [];
  let pending: string | null = null;
  for (const t of [...input.turns, ...(patientText ? [{ role: "patient", text: patientText } as Turn] : [])]) {
    if (t.role === "pod") pending = t.text;
    else {
      conversation.push(pending ? { pod_asked: pending, patient_answered: t.text } : { patient_said: t.text });
      pending = null;
    }
  }

  // Pictures as a time sequence, so Jev sees where the patient was a second ago and where they are now.
  const frames = (input.frames ?? []).slice(-MAX_FRAMES);
  const images: Record<string, string> = {};
  const frameState = frames.map((f, i) => {
    const ref = `frame-${t0}-${i}-c41d`;
    images[ref] = f.b64;
    return { seconds_ago: Math.round(f.secondsAgo), picture: ref };
  });
  const hasFrames = frames.length > 0;

  const state = {
    setting: `Village health post, ${input.region}. A community health worker is present.`,
    ...(hasFrames && { frames: frameState }),
    ...(conversation.length && { conversation }),
    ...(input.latest?.speech && {
      speech_timing: `${input.latest.speech.wordsPerSecond.toFixed(1)} words per second, ${input.latest.speech.longPauses} pauses longer than 1.5 s`,
    }),
    ...(intake.consent && { consent_answer: intake.consent }),
  };

  // Every question goes in ONE request: Jev answers them all in about a second.
  const q: Record<string, JevQuestion> = {};
  if (hasFrames || conversation.length) {
    q.age = {
      type: "choice",
      instructions: "How old is the patient (the person being described or shown)? Use what is said first, then the pictures.",
      criteria: { newborn: "Under 2 months", child: "2 months to 12 years", adult: "13 to 64 years", older_adult: "65 or older" },
    };
  }
  if (hasFrames) {
    q.person_visible = { type: "noul", instructions: "In the `frames`, is a person's face clearly visible?" };
    for (const k of visible) {
      q[`seen_${k}`] = {
        type: "noul",
        instructions: `Look at the \`frames\` (a few seconds of camera pictures, oldest first, taken while the patient was talking). ${(FINDINGS[k] as { seen: string }).seen}`,
      };
    }
  }
  if (conversation.length) {
    for (const k of FINDING_KEYS) {
      q[`said_${k}`] = {
        type: "choice",
        instructions: `From the \`conversation\`: does the patient have this? "${FINDINGS[k].label}". The conversation may be in Spanish.`,
        criteria: {
          yes: "The patient or caregiver said so, or it clearly follows from what they said.",
          no: "They said it is not the case, or answered no when asked.",
          unknown: "Not mentioned, or the answer is unclear.",
        },
      };
    }
    q.complaint = {
      type: "choice",
      instructions: "What is the patient's main problem, from the `conversation`? Ignore the name/community/consent questions.",
      criteria: { ...Object.fromEntries(PATHWAYS.map((p) => [p.id, p.description])), other: "Something else, or not said yet" },
    };
    q.speech_confused = {
      type: "noul",
      instructions: "Do the patient's own words in the `conversation` look confused, jumbled or incoherent (as with slurred speech)? Short answers like 'No', 'Sí' or a name are normal, not confused.",
    };
    q.locale = {
      type: "choice",
      instructions: `Which regional variety of language is the patient speaking in the \`conversation\`? Look at vocabulary and phrasing. If nothing is distinctive, prefer ${input.defaultLocale}.`,
      criteria: LOCALES,
    };
    for (const p of PATHWAYS) {
      q[`sub_${p.id}`] = {
        type: "choice",
        instructions: `Assume the patient's problem is in this area: ${p.label}. Given the \`conversation\`${hasFrames ? " and the `frames`" : ""}, which of these is most likely?`,
        criteria: Object.fromEntries(p.subtypes.map((s) => [s.name, s.description])),
      };
    }
  }
  if (intake.consent) {
    q.consent = { type: "noul", instructions: "In `consent_answer`, did the person agree to have their name and health needs saved?" };
  }

  const a = Object.keys(q).length ? await jev(state, q, images) : {}; // nothing to ask before any picture or words

  // What the camera sees: everything seen so far this visit, refreshed by the new pictures and by
  // the on-device face-droop check.
  const seen: Seen = { ...input.seen };
  if (hasFrames && noulOf(a.person_visible) >= 0.5) for (const k of visible) seen[k] = Math.max(seen[k] ?? 0, noulOf(a[`seen_${k}`]));
  if (input.camera.droop?.flagged || input.camera.smileTest === "asymmetric") seen.face_or_arm_weakness = Math.max(seen.face_or_arm_weakness ?? 0, 0.95);

  // Physical test results count like things seen.
  const tested = new Map<FindingKey, number>();
  for (const result of Object.values(input.tests)) {
    for (const [k, v] of Object.entries(result ?? {}) as [FindingKey, number][]) tested.set(k, Math.max(tested.get(k) ?? 0, v));
  }

  const asked = new Set(input.turns.filter((t) => t.role === "pod" && t.asks).map((t) => t.asks!));
  const speechConfused = noulOf(a.speech_confused);

  const yes = {} as Record<FindingKey, number>;
  const known = {} as Record<FindingKey, boolean>;
  const findings: FindingState[] = [];
  for (const k of FINDING_KEYS) {
    const said = probsOf(a[`said_${k}`]);
    const s = Math.max(seen[k] ?? 0, tested.get(k) ?? 0);
    let y = Math.max(said.yes ?? 0, s >= YES ? s : 0);
    if (k === "confused_speech" && speechConfused >= 0.8) y = Math.max(y, speechConfused);
    yes[k] = y;
    known[k] = asked.has(k) || (said.yes ?? 0) + (said.no ?? 0) >= 0.6 || s >= 0.75;
    if (k !== "wants_peer_group" && (y >= 0.3 || asked.has(k))) {
      const fromSaid = (said.yes ?? 0) >= 0.3, fromSeen = s >= YES;
      findings.push({ key: k, label: FINDINGS[k].label, yes: y, known: known[k], source: fromSaid && fromSeen ? "both" : fromSeen ? "seen" : "said" });
    }
  }

  const agePs = probsOf(a.age);
  const age = ((Object.entries(agePs).sort((x, y) => y[1] - x[1])[0]?.[0] as AgeGroup) ?? "adult") as AgeGroup;
  const isChild = age === "newborn" || age === "child";

  // Pathways: opened by the main complaint or by any trigger finding.
  const complaint = probsOf(a.complaint);
  const pathways: PathwayState[] = PATHWAYS.map((p) => {
    const sub = probsOf(a[`sub_${p.id}`]);
    return {
      id: p.id,
      label: p.label,
      probability: Math.max(complaint[p.id] ?? 0, ...p.triggers.map((k) => yes[k])),
      subtypes: p.subtypes
        .map((s) => ({ name: s.name, probability: sub[s.name] ?? 0, urgency: s.urgency }))
        .sort((x, y) => y.probability - x.probability),
    };
  }).sort((x, y) => y.probability - x.probability);
  const open = pathways.filter((p) => p.probability >= OPEN);

  // Sub-classifications become likely causes; supplies add up across them.
  const causes: Cause[] = [];
  const need = new Map<string, number>();
  for (const p of open) {
    const def = PATHWAYS.find((d) => d.id === p.id)!;
    for (const s of p.subtypes) {
      const prob = p.probability * s.probability;
      if (prob < 0.05) continue;
      const sdef = def.subtypes.find((d) => d.name === s.name)!;
      causes.push({ name: s.name, pathway: p.label, probability: prob, urgency: s.urgency, why: sdef.description });
      for (const item of sdef.resources) need.set(item, 1 - (1 - (need.get(item) ?? 0)) * (1 - prob));
    }
  }
  causes.sort((x, y) => y.probability - x.probability);

  // Safety rules run on yes/no facts.
  const facts = Object.fromEntries(FINDING_KEYS.map((k) => [k, yes[k] >= YES])) as unknown as Findings;
  facts.age_group = age;
  const ruleHits = runRules(facts, input.camera);
  for (const hit of ruleHits) {
    const p = hit.urgency === "red" ? 0.9 : 0.7;
    for (const item of hit.resources) {
      const key = [...need.keys()].find((i) => sameItem(i, item)) ?? item;
      need.set(key, Math.max(need.get(key) ?? 0, p));
    }
  }
  const resources: Resource[] = [];
  for (const [item, probability] of [...need.entries()].sort((x, y) => y[1] - x[1])) {
    if (!resources.some((r) => sameItem(r.item, item))) resources.push({ item, probability, delivery: deliveryFor(item) });
  }

  // Urgency: any rule, or any red/yellow condition that is reasonably likely, can't be ruled out.
  const causeUrgency = causes.filter((c) => c.probability >= 0.3).map((c) => c.urgency);
  const urgency: Urgency = maxUrgency(...ruleHits.map((h) => h.urgency), ...causeUrgency);
  const redRule = ruleHits.some((h) => h.urgency === "red");

  // ---- Next step ----
  const say = (asks: Step | null, t: { en: string; es: string }): TriageResult["next"] => ({ asks, text: t[language], english: t.en });
  const emergencySeen = EMERGENCY_SEEN.some((k) => (seen[k] ?? 0) >= YES);
  const intakeOpen = !redRule && !emergencySeen && !asked.has("open");
  const medicalSteps = input.turns.filter((t) => t.role === "pod" && t.asks && !t.asks.startsWith("intake:") && t.asks !== "open").length;
  const testDone = (id: string) => id in input.tests || asked.has(`test:${id}`);
  const moodish = (["low_mood", "little_interest", "anxious", "trauma_or_loss"] as FindingKey[]).some((k) => yes[k] >= YES);

  let next: TriageResult["next"] = null;
  const seenOpener = () => {
    const k = (Object.keys(SEEN_OPENERS) as FindingKey[]).filter((f) => (seen[f] ?? 0) >= YES).sort((x, y) => (seen[y] ?? 0) - (seen[x] ?? 0))[0];
    return k ? say(SEEN_OPENER_ASKS[k] ?? k, SEEN_OPENERS[k]!) : null;
  };

  if (input.stage === "look") {
    next = intakeOpen ? say("intake:name", INTAKE.name) : seenOpener() ?? say("open", OPENING);
  } else if (intakeOpen && INTAKE_FIELDS.some((f) => !asked.has(`intake:${f}`))) {
    const f = INTAKE_FIELDS.find((x) => !asked.has(`intake:${x}`))!;
    next = say(`intake:${f}`, INTAKE[f]);
  } else if (!asked.has("open") && !redRule) {
    next = seenOpener() ?? say("open", OPENING);
  } else if (!redRule && medicalSteps < MAX_STEPS) {
    const order: Step[] = [];
    if (isChild && open.length) order.push("unable_to_drink", "vomits_everything", "seizure", "very_sleepy");
    for (const p of open) order.push(...PATHWAYS.find((d) => d.id === p.id)!.questions);
    if (!open.length) order.push("low_mood", "little_interest"); // nothing physical found: screen mood
    const pick = order.find((s) => {
      if (s.startsWith("test:")) {
        const t = TESTS.find((x) => `test:${x.id}` === s)!;
        return !testDone(t.id) && (!t.childOnly || isChild);
      }
      if (s === "wants_peer_group") return !asked.has(s) && moodish;
      return !known[s as FindingKey];
    });
    if (pick?.startsWith("test:")) {
      const t = TESTS.find((x) => `test:${x.id}` === pick)!;
      next = { ...say(pick, t.say)!, test: { id: t.id, label: t.label, seconds: t.seconds } };
    } else if (pick) {
      next = say(pick, FINDINGS[pick as FindingKey].ask);
    } else if (!open.length && medicalSteps < 3) {
      next = say(null, MORE);
    }
  }
  const done = input.stage === "answer" && !next;
  if (done) next = say(null, ruleHits.some((h) => h.id === "suicide_risk") ? CLOSING_SUICIDE_RISK : CLOSING[urgency]);

  const top = ruleHits[0]?.label ?? (causes[0] ? `Most likely: ${causes[0].name} (${Math.round(causes[0].probability * 100)}%)` : "No danger signs found so far");
  const mental = pathways.find((p) => p.id === "mental");

  return {
    language,
    locale: topKey(probsOf(a.locale)) ?? input.defaultLocale,
    locale_reason: localeReason(probsOf(a.locale)),
    age_group: age,
    patient_text: patientText,
    seen,
    findings: findings.sort((x, y) => y.yes - x.yes),
    pathways: pathways.filter((p) => p.probability >= 0.15),
    causes: causes.slice(0, 6),
    urgency,
    resources,
    doctor_required: urgency !== "green",
    reason: top,
    rule_hits: ruleHits,
    speech_confused: speechConfused,
    done,
    answered,
    next,
    consent: intake.consent ? noulOf(a.consent) : null,
    peer_group: {
      wants: yes.wants_peer_group >= YES && !facts.self_harm_thoughts,
      category: mental && mental.probability >= OPEN ? (mental.subtypes[0]?.name ?? null) : null,
    },
    jev_ms: Date.now() - t0,
  };
}

const MORE = { en: "Can you tell me more about how you feel and where it hurts?", es: "¿Me puede contar más de cómo se siente y dónde le duele?" };

// Jev watches the pictures taken during a physical test.
export async function judgeTest(testId: string, frames: Frame[], region: string) {
  const t = TESTS.find((x) => x.id === testId);
  if (!t) throw new Error(`Unknown test ${testId}`);
  const pics = frames.slice(-8);
  const images: Record<string, string> = {};
  const frameState = pics.map((f, i) => {
    const ref = `test-${testId}-${Date.now()}-${i}-9b2e`;
    images[ref] = f.b64;
    return { seconds_ago: Math.round(f.secondsAgo), picture: ref };
  });
  const q: Record<string, JevQuestion> = {
    did_it: { type: "noul", instructions: `In the \`frames\`, did the person attempt this: "${t.say.en}"?` },
  };
  t.checks.forEach((c, i) => {
    q[`check_${i}`] = { type: "noul", instructions: `The \`frames\` show a patient doing this test: "${t.say.en}". Oldest picture first. ${c.question}` };
  });
  const a = await jev({ setting: `Village health post, ${region}.`, test: t.label, frames: frameState }, q, images);
  const attempted = noulOf(a.did_it) >= 0.4;
  const results: Partial<Record<FindingKey, number>> = {};
  if (attempted) t.checks.forEach((c, i) => (results[c.finding] = Math.max(results[c.finding] ?? 0, noulOf(a[`check_${i}`]))));
  return { attempted, results };
}

function topKey(p: Record<string, number>): string | undefined {
  return Object.entries(p).sort((x, y) => y[1] - x[1])[0]?.[0];
}

function localeReason(p: Record<string, number>): string {
  const ranked = Object.entries(p).sort((x, y) => y[1] - x[1]).slice(0, 3);
  return ranked.map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(" · ");
}

// "Amoxicillin" and "Amoxicillin dispersible tablets" are the same supply line.
function sameItem(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3 && w !== "with"));
  const wa = words(a), wb = words(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / Math.max(1, Math.min(wa.size, wb.size)) >= 0.6;
}

function deliveryFor(item: string): Resource["delivery"] {
  const s = item.toLowerCase();
  if (/(transport|oxygen|referral|hospital|\bct\b|maternity|iv fluids|ecg|sputum)/.test(s)) return "road";
  if (/(amoxicillin|rehydration|zinc|rapid test|pulse|glucose|blood pressure|check|paracetamol|dressing|bandage|splint|advice|antacid|review|visit|dipstick|sessions|group|stays with)/.test(s)) return "on_site";
  return "drone";
}
