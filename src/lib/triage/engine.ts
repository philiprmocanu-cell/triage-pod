// One triage step, driven by Jev. A visit runs:
//  look   -> Jev watches a few seconds of camera pictures for every visible sign.
//  intake -> name, community, who the patient is, consent to be saved (skipped in an emergency).
//  open   -> "what is bothering you?"
//  then   -> pathway questions and physical tests, chosen from what was seen and said.
// After every answer Jev re-reads the whole conversation plus the pictures taken while the patient
// was talking, and answers every finding, pathway and sub-classification in one request.
// Code then opens pathways, picks the next step, applies the safety rules and adds up supplies.

import { jev, JevQuestion, noulOf, probsOf } from "../jev";
import { advisoriesFor } from "../agents";
import { postFor } from "../network";
import { confirmComplaint, followUpQuestion, replyToPatient } from "./brain";
import { communityLexicon, learnFrom, Lexicon, speakLike } from "./dialect";
import { NOTICED, TRAITS, TraitScan } from "./traits";
import { getVitals } from "../session";
import { maxUrgency, runRules, vitalsRules } from "./rules";
import {
  CLOSING,
  CLOSING_SUICIDE_RISK,
  FINDING_KEYS,
  FINDINGS,
  FindingKey,
  HISTORY,
  HistoryField,
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

const MAX_STEPS = 10; // medical questions + tests after the history questions
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
  traits?: TraitScan; // latest live physical scan (strongest reading of each trait this visit)
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
      let pick = a.lang?.type === "choice" ? a.lang.choice : entries[0][0];
      // Stay in the patient's language unless they clearly switched: "No" or "Sí" alone is
      // the same in both and must not flip the conversation into English.
      const words = (input.latest.candidates[pick] ?? "").split(/\s+/).filter(Boolean).length;
      const sure = a.lang?.type === "choice" ? a.lang.confidence : 0;
      if (input.language && pick !== input.language && input.latest.candidates[input.language] && (words < 4 || sure < 0.8)) pick = input.language;
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
    q.sex = {
      type: "choice",
      instructions: "Is the patient (the person being described or shown) male or female? Use what is said (name, words like 'embarazada', 'mi esposo') first, then the pictures.",
      criteria: { female: "Female", male: "Male", unknown: "Cannot tell" },
    };
    q.age = {
      type: "choice",
      instructions: "How old is the patient (the person being described or shown)? Use what is said first, then the pictures.",
      criteria: { newborn: "Under 2 months", child: "2 months to 12 years", adult: "13 to 64 years", older_adult: "65 or older" },
    };
  }
  const scanning = Object.keys(input.traits ?? {}).length > 0;
  if (hasFrames && !scanning) {
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
        instructions:
          k === "confused_speech"
            ? "From the `conversation`: did the patient or caregiver SAY that the patient's speech has become slurred or that words come out wrong? Only count what they report, not how they answered."
            : `From the \`conversation\`: does the patient have this? "${FINDINGS[k].label}". The conversation may be in Spanish.`,
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
        criteria: {
          ...Object.fromEntries(p.subtypes.map((s) => [s.name, s.description])),
          [UNSURE]: "Not enough information yet to tell these apart",
        },
      };
    }
  }
  // Skip intake questions the patient already answered on their own ("Rosa, from Cobán").
  const ALREADY: Partial<Record<keyof Intake, string>> = {
    community: "Has the patient already said which community, village or town they are from?",
    who: "Has the patient already said who the visit is for and that person's age?",
  };
  const ALREADY_HISTORY: Record<string, string> = {
    onset: "Has the patient already said since when or for how long they have felt this way?",
    impact: "Has the patient already said how this affects their daily life or what they cannot do?",
  };
  if (conversation.length) for (const [f, question] of Object.entries(ALREADY_HISTORY)) q[`already_h_${f}`] = { type: "noul", instructions: `From the \`conversation\`: ${question}` };
  if (conversation.length) {
    for (const [f, question] of Object.entries(ALREADY)) {
      if (!intake[f as keyof Intake]) q[`already_${f}`] = { type: "noul", instructions: `From the \`conversation\`: ${question}` };
    }
  }
  // Speech test: did they TRY to repeat the sentence, and if so, did it come out garbled?
  // Transcription slips or answering in another language are not garbled speech.
  const speechTest = lastPod?.asks === "confused_speech" && Boolean(patientText);
  if (speechTest) {
    const ctx = `The pod asked the patient to repeat this sentence: ${lastPod!.text}. The speech-to-text heard: "${patientText}".`;
    q.speech_attempted = { type: "noul", instructions: `${ctx} Did the patient actually try to repeat the sentence (rather than answering something else, asking a question, or refusing)?` };
    q.speech_garbled = {
      type: "noul",
      instructions: `${ctx} Assuming they tried, is their version clearly garbled: many words missing, jumbled, or replaced by nonsense? Small differences, filler words, a translation into another language, or speech-to-text spelling slips do NOT count.`,
    };
  }
  // Is the patient answering, asking something back, or asking to hear it again?
  if (patientText && lastPod) {
    const ctx = `The pod last said: "${lastPod.text}". The patient then said: "${patientText}".`;
    q.patient_asked = { type: "noul", instructions: `${ctx} Is the patient asking the pod a question or asking for help/advice (e.g. what is wrong, what to do, is it serious), rather than only answering?` };
    q.repeat_request = { type: "noul", instructions: `${ctx} Is the patient asking the pod to repeat, or saying they did not hear or understand?` };
    q.answered_last = { type: "noul", instructions: `${ctx} Does the patient's reply actually answer what the pod asked or said (any clear answer counts, including yes, no, or "I don't know")?` };
  }
  if (patientText && lastPod?.asks === "history:confirm") {
    q.confirm_wrong = { type: "noul", instructions: `The pod restated the problem as: "${lastPod.text}". The patient replied: "${patientText}". Did the patient say the pod understood wrong, or correct it?` };
  }
  if (intake.consent) {
    q.consent = { type: "noul", instructions: "In `consent_answer`, did the person agree to have their name and health needs saved?" };
  }

  const a = Object.keys(q).length ? await jev(state, q, images) : {}; // nothing to ask before any picture or words

  // What the camera sees: everything seen so far this visit, refreshed by the new pictures and by
  // the on-device face-droop check.
  const seen: Seen = { ...input.seen };
  if (hasFrames && !scanning && noulOf(a.person_visible) >= 0.5) for (const k of visible) seen[k] = Math.max(seen[k] ?? 0, noulOf(a[`seen_${k}`]));
  // The live scan (already smoothed over several scans): traits tied to a finding count as seen.
  // Everything the camera notices is also a hunch to ask about, never a conclusion on its own.
  const hints: Record<string, { p: number; why: string }> = {};
  const hunches: { trait: string; pathway: string | null; finding: FindingKey | null; p: number }[] = [];
  for (const t of TRAITS) {
    const p = input.traits?.[t.id] ?? 0;
    if (t.finding) seen[t.finding] = Math.max(seen[t.finding] ?? 0, p);
    if (t.hint && p >= 0.6 && p > (hints[t.hint]?.p ?? 0)) hints[t.hint] = { p, why: t.label.toLowerCase() };
    if (p >= 0.6 && NOTICED[t.id]) hunches.push({ trait: t.id, pathway: t.hint ?? null, finding: t.finding ?? null, p });
  }
  if (input.camera.droop?.flagged) hunches.push({ trait: "face_droop", pathway: "stroke", finding: "face_or_arm_weakness", p: 0.8 });
  if (input.camera.smileTest === "asymmetric") seen.face_or_arm_weakness = Math.max(seen.face_or_arm_weakness ?? 0, 0.95);
  hunches.sort((x, y) => y.p - x.p);

  // Physical test results count like things seen.
  const tested = new Map<FindingKey, number>();
  for (const result of Object.values(input.tests)) {
    for (const [k, v] of Object.entries(result ?? {}) as [FindingKey, number][]) tested.set(k, Math.max(tested.get(k) ?? 0, v));
  }

  const asked = new Set(input.turns.filter((t) => t.role === "pod" && t.asks).map((t) => t.asks!));
  const podPost = postFor(intake.community);
  const advisories = advisoriesFor(podPost);
  for (const f of INTAKE_FIELDS) if (intake[f]) asked.add(`intake:${f}`); // answered earlier, maybe unasked
  for (const f of ["community", "who"] as const) {
    if (noulOf(a[`already_${f}`]) >= 0.8) {
      asked.add(`intake:${f}`);
      intake[f] ??= patientText ?? [...input.turns].reverse().find((t) => t.role === "patient")?.text;
    }
  }
  const speechConfused = noulOf(a.speech_confused);

  const yes = {} as Record<FindingKey, number>;
  const saidYes = {} as Record<FindingKey, number>;
  const known = {} as Record<FindingKey, boolean>;
  const findings: FindingState[] = [];
  for (const k of FINDING_KEYS) {
    const said = probsOf(a[`said_${k}`]);
    const s = Math.max(seen[k] ?? 0, tested.get(k) ?? 0);
    let y = Math.max(said.yes ?? 0, s >= YES ? s : 0);
    if (k === "confused_speech" && speechTest && noulOf(a.speech_attempted) >= 0.7) y = Math.max(y, noulOf(a.speech_garbled) >= 0.75 ? noulOf(a.speech_garbled) : 0);
    yes[k] = y;
    saidYes[k] = said.yes ?? 0;
    known[k] = asked.has(k) || (said.yes ?? 0) + (said.no ?? 0) >= 0.6 || s >= 0.75;
    if (k !== "wants_peer_group" && (y >= 0.3 || asked.has(k))) {
      const fromSaid = (said.yes ?? 0) >= 0.3, fromSeen = s >= YES;
      findings.push({ key: k, label: FINDINGS[k].label, yes: y, known: known[k], source: fromSaid && fromSeen ? "both" : fromSeen ? "seen" : "said" });
    }
  }

  const agePs = probsOf(a.age);
  const age = ((Object.entries(agePs).sort((x, y) => y[1] - x[1])[0]?.[0] as AgeGroup) ?? "adult") as AgeGroup;
  const isChild = age === "newborn" || age === "child";
  // Only ask about pregnancy when it is possible: not a man, a young child or an older adult.
  const sexPs = probsOf(a.sex);
  const pregnancyPossible = (sexPs.male ?? 0) < 0.7 && !isChild && age !== "older_adult";

  // No conclusions before the patient has said what brought them in.
  const openIdx = input.turns.findIndex((t) => t.role === "pod" && t.asks === "open");
  const complaintKnown =
    openIdx >= 0 && (input.turns.slice(openIdx + 1).some((t) => t.role === "patient") || (Boolean(patientText) && lastPod?.asks === "open"));

  // Pathways: opened by the main complaint or by a confirmed symptom. Camera hunches only add
  // questions; they never open a pathway by themselves.
  const complaint = complaintKnown ? probsOf(a.complaint) : {};
  const pathways: PathwayState[] = PATHWAYS.map((p) => {
    const sub = probsOf(a[`sub_${p.id}`]);
    return {
      id: p.id,
      label: p.label,
      probability: complaintKnown ? Math.max(complaint[p.id] ?? 0, ...p.triggers.map((k) => yes[k])) : 0,
      subtypes: p.subtypes
        .map((s) => ({ name: s.name, probability: sub[s.name] ?? 0, urgency: s.urgency }))
        .sort((x, y) => y.probability - x.probability),
    };
  }).sort((x, y) => y.probability - x.probability);
  const open = pathways.filter((p) => p.probability >= OPEN);
  // A pathway opened by the camera or the complaint, not by a confirmed symptom, first asks
  // about its main symptom ("I see you holding your chest" -> "do you have chest pain?").
  const stepsFor = (id: string): Step[] => {
    const def = PATHWAYS.find((d) => d.id === id)!;
    const confirmed = def.triggers.some((k) => saidYes[k] >= YES);
    return confirmed || def.questions.includes(def.triggers[0]) ? def.questions : [def.triggers[0], ...def.questions];
  };

  // Sub-classifications become likely causes; supplies add up across them.
  const causes: Cause[] = [];
  const need = new Map<string, number>();
  for (const p of complaintKnown ? open : []) {
    const def = PATHWAYS.find((d) => d.id === p.id)!;
    // Confidence grows with every answered question or finished test in this pathway.
    const answered = stepsFor(p.id).filter((st) => (st.startsWith("test:") ? st.slice(5) in input.tests : asked.has(st) || saidYes[st as FindingKey] >= YES)).length;
    const confidence = Math.min(1, 0.35 + 0.15 * answered);
    for (const s of p.subtypes) {
      const prob = p.probability * s.probability * confidence;
      if (prob < 0.05) continue;
      const sdef = def.subtypes.find((d) => d.name === s.name)!;
      const keys = [...new Set([...def.triggers, ...def.questions.filter((q): q is FindingKey => !q.startsWith("test:"))])];
      const src = (k: FindingKey) => ((tested.get(k) ?? 0) >= YES ? "test" : (seen[k] ?? 0) >= YES ? "camera" : "said");
      const evidence = keys.filter((k) => yes[k] >= YES).map((k) => `${FINDINGS[k].label} (${src(k)})`);
      if (hints[p.id]) evidence.push(`camera: ${hints[p.id].why}`);
      const against = keys.filter((k) => known[k] && yes[k] < 0.3 && asked.has(k)).map((k) => `no ${FINDINGS[k].label.toLowerCase()}`);
      causes.push({ name: s.name, pathway: p.label, probability: prob, urgency: s.urgency, why: sdef.description, evidence, against, early: confidence < 0.8, confident: false });
      for (const item of sdef.resources) need.set(item, 1 - (1 - (need.get(item) ?? 0)) * (1 - prob));
    }
  }
  causes.sort((x, y) => y.probability - x.probability);

  // Safety rules run on yes/no facts.
  const facts = Object.fromEntries(FINDING_KEYS.map((k) => [k, yes[k] >= YES])) as unknown as Findings;
  facts.age_group = age;
  facts.weakness_reported = saidYes.face_or_arm_weakness >= YES; // the camera alone never counts as reported weakness
  // Measured vitals (typed in by the health worker) join the safety rules.
  const vitals = getVitals();
  if (vitals.tempC != null && vitals.tempC >= 38) facts.fever = true;
  const ruleHits = [...vitalsRules(vitals, facts), ...runRules(facts, input.camera)].sort((x, y) => URGENCY_RANK_LOCAL[y.urgency] - URGENCY_RANK_LOCAL[x.urgency]);
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

  // A fired safety rule is the strongest evidence there is: its condition goes to the top.
  for (const hit of ruleHits) {
    const name = RULE_CAUSE[hit.id];
    if (!name) continue;
    const c = causes.find((x) => x.name === name);
    const p = hit.urgency === "red" ? 0.95 : 0.8;
    if (c) {
      c.probability = Math.max(c.probability, p);
      c.early = false;
      c.evidence.unshift(`safety rule: ${hit.evidence}`);
    } else {
      const path = PATHWAYS.find((d) => d.subtypes.some((x) => x.name === name))!;
      const sub = path.subtypes.find((x) => x.name === name)!;
      causes.push({ name, pathway: path.label, probability: p, urgency: sub.urgency, why: sub.description, evidence: [`safety rule: ${hit.evidence}`], against: [], early: false, confident: true });
    }
  }
  causes.sort((x, y) => y.probability - x.probability);

  // A condition is only named when the evidence strongly supports it: a safety rule fired, or
  // it is past the early stage, at least 70% likely, and backed by two separate findings.
  for (const c of causes) {
    const ruleBacked = c.evidence.some((e) => e.startsWith("safety rule"));
    c.confident = ruleBacked || (!c.early && c.probability >= CONFIDENT && c.evidence.length >= 2);
  }

  // Urgency comes from safety rules and strongly supported conditions only, never from guesses.
  const causeUrgency = causes.filter((c) => c.confident).map((c) => c.urgency);
  const urgency: Urgency = maxUrgency(...ruleHits.map((h) => h.urgency), ...causeUrgency);
  const redRule = ruleHits.some((h) => h.urgency === "red");
  const strokeRed = redRule && ruleHits.filter((h) => h.urgency === "red").every((h) => h.id.startsWith("stroke"));

  // ---- Next step ----
  const say = (asks: Step | null, t: { en: string; es: string }): TriageResult["next"] => ({ asks, text: t[language], english: t.en });
  const emergencySeen = EMERGENCY_SEEN.some((k) => (seen[k] ?? 0) >= YES);
  const intakeOpen = !redRule && !emergencySeen && !asked.has("open");
  const medicalSteps = input.turns.filter((t) => t.role === "pod" && t.asks && !t.asks.startsWith("intake:") && !t.asks.startsWith("history:") && t.asks !== "open").length;
  // Confirmation: after each telling of the complaint, say it back once; a "no" means tell it again.
  const lastOpen = input.turns.map((t) => t.asks).lastIndexOf("open");
  const answeredOpenNow = Boolean(patientText) && lastPod?.asks === "open";
  const confirmAfterOpen = lastOpen >= 0 && input.turns.slice(lastOpen + 1).some((t) => t.asks === "history:confirm");
  const needConfirm = complaintKnown && answeredOpenNow && !confirmAfterOpen;
  const confirmedWrong = lastPod?.asks === "history:confirm" && noulOf(a.confirm_wrong) >= 0.6;
  const retells = input.turns.filter((t) => t.role === "pod" && t.asks === "open").length - 1;
  for (const f of ["onset", "impact"] as HistoryField[]) if (noulOf(a[`already_h_${f}`]) >= 0.8) asked.add(`history:${f}`);
  const testDone = (id: string) => id in input.tests || asked.has(`test:${id}`);
  const moodish = (["low_mood", "little_interest", "anxious", "trauma_or_loss", "lonely"] as FindingKey[]).some((k) => yes[k] >= YES);

  let next: TriageResult["next"] = null;
  // Explore what the camera noticed, at most two hunches: "I see you holding your chest. Do you
  // have pain or pressure in your chest?"
  const hunchTurns = input.turns.filter((t) => t.role === "pod" && t.english?.startsWith("[hunch:"));
  const hunchAsked = hunchTurns.length;
  const hunchUsed = new Set(hunchTurns.map((t) => t.english!.slice(7, t.english!.indexOf("]"))));
  const nextHunch = (): TriageResult["next"] => {
    if (!complaintKnown || hunchAsked >= 2) return null;
    for (const h of hunches) {
      if (hunchUsed.has(h.trait)) continue;
      const path = h.pathway ? PATHWAYS.find((d) => d.id === h.pathway) : PATHWAYS.find((d) => h.finding && (d.triggers.includes(h.finding) || d.questions.includes(h.finding)));
      if (path && open.some((o) => o.id === path.id)) continue; // already being explored
      const step: Step | undefined = h.trait === "face_droop" ? "test:smile" : path?.triggers.find((k) => !known[k]) ?? (h.finding && !known[h.finding] ? h.finding : undefined);
      if (!step || asked.has(step) || (step.startsWith("test:") && testDone(step.slice(5)))) continue;
      const n = NOTICED[h.trait];
      if (step.startsWith("test:")) {
        const t = TESTS.find((x) => `test:${x.id}` === step)!;
        return { asks: step, text: `${n[language]} ${t.say[language]}`, english: `[hunch:${h.trait}] ${n.en} ${t.say.en}`, test: { id: t.id, label: t.label, seconds: t.seconds, prep: t.prep } };
      }
      const f = FINDINGS[step as FindingKey];
      return { asks: step, text: `${n[language]} ${f.ask[language]}`, english: `[hunch:${h.trait}] ${n.en} ${f.ask.en}` };
    }
    return null;
  };
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
  } else if (strokeRed && medicalSteps < MAX_STEPS) {
    // Suspected stroke: help is called, but the quick bedside tests (smile, arms, walk) still run
    // so the doctor gets the full picture on arrival.
    // No walking once a stroke is flagged: fall risk. The speech check replaces it.
    const t = (["test:smile", "test:arm_drift"] as Step[]).find((st) => !testDone(st.slice(5)));
    if (!t && !asked.has("confused_speech")) next = say("confused_speech", FINDINGS.confused_speech.ask);
    if (t) {
      const def = TESTS.find((x) => `test:${x.id}` === t)!;
      const first = !["smile", "arm_drift"].some((id) => testDone(id));
      next = {
        asks: t,
        text: `${first ? HELP_NOW[language] + " " : ""}${def.say[language]}`,
        english: `${first ? HELP_NOW.en + " " : ""}${def.say.en}`,
        test: { id: def.id, label: def.label, seconds: def.seconds, prep: def.prep },
      };
    }
  } else if (!redRule && needConfirm) {
    // Say back what we heard before reasoning on it.
    const said = patientText ?? [...input.turns].reverse().find((t) => t.role === "patient")?.text ?? "";
    let c: Awaited<ReturnType<typeof confirmComplaint>> = "UNCLEAR";
    try {
      c = await confirmComplaint({ said, language, locale: topKey(probsOf(a.locale)) ?? input.defaultLocale });
    } catch {
      c = { text: `${language === "es" ? "Entendí" : "I heard"}: "${said}". ${HISTORY.confirm[language]}`, english: `I heard: "${said}". Is that right?` };
    }
    next = c === "UNCLEAR" ? say("open", RETELL) : { asks: "history:confirm", text: c.text, english: c.english };
  } else if (!redRule && confirmedWrong && retells < 2) {
    next = say("open", RETELL);
  } else if (!redRule && (["onset", "impact", "severity"] as HistoryField[]).some((f) => !asked.has(`history:${f}`))) {
    const f = (["onset", "impact", "severity"] as HistoryField[]).find((x) => !asked.has(`history:${x}`))!;
    next = say(`history:${f}`, HISTORY[f]);
  } else if (!redRule && medicalSteps < MAX_STEPS && nextHunch()) {
    next = nextHunch();
  } else if (!redRule && medicalSteps < MAX_STEPS) {
    const order: Step[] = [];
    // Network advisories from the outbreak sentinel: screen for what is spreading nearby first.
    for (const adv of advisories) if (complaintKnown && !known[ADVISORY_FIRST[adv.kind]]) order.push(ADVISORY_FIRST[adv.kind]);
    if (isChild && open.length) order.push("unable_to_drink", "vomits_everything", "seizure", "very_sleepy");
    for (const p of open) order.push(...stepsFor(p.id));
    // Nothing in the tree fits (toothache, ear pain...): ask Claude for one sensible nurse
    // follow-up question, up to three times, before falling back to the mood screen.
    const freeAsked = input.turns.filter((t) => t.role === "pod" && t.asks === "free").length;
    if (!open.length && complaintKnown && freeAsked < 3) {
      try {
        const q = await followUpQuestion({ conversation, language, locale: topKey(probsOf(a.locale)) ?? input.defaultLocale });
        if (q) next = { asks: "free", text: q.text, english: q.english };
      } catch {
        /* fall through to the screen below */
      }
    }
    if (!open.length) order.push("low_mood", "little_interest", "lonely"); // nothing physical found: screen mood and loneliness
    else if (age === "older_adult") order.push("lonely"); // older adults are the loneliest group: always ask
    const pick = next ? undefined : order.find((s) => {
      if (s.startsWith("test:")) {
        const t = TESTS.find((x) => `test:${x.id}` === s)!;
        return !testDone(t.id) && (!t.childOnly || isChild);
      }
      if (s === "wants_peer_group") return !asked.has(s) && moodish;
      if (s === "pregnant" && !pregnancyPossible) return false;
      return !known[s as FindingKey];
    });
    if (pick?.startsWith("test:")) {
      const t = TESTS.find((x) => `test:${x.id}` === pick)!;
      next = { ...say(pick, t.say)!, test: { id: t.id, label: t.label, seconds: t.seconds, prep: t.prep } };
    } else if (pick) {
      const f = FINDINGS[pick as FindingKey];
      next = say(pick, isChild && "askChild" in f ? f.askChild : f.ask);
    } else if (!next && !open.length && medicalSteps < 3) {
      next = say(null, MORE);
    }
  }
  if (!next && input.stage === "answer" && !redRule && complaintKnown && !asked.has("history:else")) next = say("history:else", HISTORY.else);
  const done = input.stage === "answer" && !next;
  if (done) next = say(null, ruleHits.some((h) => h.id === "suicide_risk") ? CLOSING_SUICIDE_RISK : CLOSING[urgency]);

  const lastAsked = lastPod?.asks;
  const reAsked = (lastPod?.text ?? "").startsWith(SORRY[language]);
  if (patientText && lastPod && !done && !redRule) {
    if (noulOf(a.repeat_request) >= 0.6) {
      next = { asks: lastAsked ?? null, text: `${CLARO[language]} ${stripPrefix(lastPod.text, language)}`, english: lastPod.english ?? lastPod.text };
    } else if (speechTest && noulOf(a.speech_attempted) < 0.7 && !reAsked) {
      next = {
        asks: "confused_speech",
        text: `${SORRY[language]} ${SPEECH_AGAIN[language]} ${stripPrefix(lastPod!.text, language).replace(/^.*?:\s*/, "")}`,
        english: `Sorry, I didn't quite understand. ${SPEECH_AGAIN.en}`,
      };
    } else if (noulOf(a.patient_asked) < 0.6 && noulOf(a.answered_last) < 0.3 && lastAsked && !reAsked && !lastAsked.startsWith("test:")) {
      next = { asks: lastAsked, text: `${SORRY[language]} ${stripPrefix(lastPod.text, language)}`, english: `Sorry, I didn't quite understand. ${lastPod.english ?? ""}` };
    }
  }
  if (patientText && noulOf(a.patient_asked) >= 0.6 && noulOf(a.repeat_request) < 0.6 && next) {
    let reply: string;
    try {
      reply = await replyToPatient({
        conversation: conversation.map((c) => ({ speaker: "exchange", said: JSON.stringify(c) })),
        question: patientText,
        language,
        locale: topKey(probsOf(a.locale)) ?? input.defaultLocale,
        urgency,
        likely: causes.filter((c) => c.confident).slice(0, 3).map((c) => c.name),
      });
    } catch {
      reply = HELP_COMING[language];
    }
    next = { ...next, text: `${reply} ${next.text}`, english: `[answering the patient] ${next.english}` };
  }

  // Talk back with the patient's own words: what this patient said, on top of what their
  // community taught the pod on earlier visits.
  const patientWords = [...input.turns.filter((t) => t.role === "patient").map((t) => t.text), ...(patientText ? [patientText] : [])];
  const lexicon: Lexicon = { ...(await communityLexicon(intake.community)), ...learnFrom(patientWords) };
  if (next && language === "es") next = { ...next, text: speakLike(next.text, lexicon) };

  // Make the logic visible: why each pathway opened, and where each of its steps stands.
  const label = (st: Step) =>
    st.startsWith("test:") ? `Test: ${TESTS.find((t) => `test:${t.id}` === st)?.label}` : FINDINGS[st as FindingKey]?.label ?? st;
  const openedBy = (id: string) => {
    const def = PATHWAYS.find((d) => d.id === id)!;
    const why = def.triggers.filter((k) => yes[k] >= YES).map((k) => `${FINDINGS[k].label.toLowerCase()} (${(seen[k] ?? 0) >= YES ? "seen" : "said"})`);
    if ((complaint[id] ?? 0) >= OPEN) why.unshift(`main complaint (${Math.round((complaint[id] ?? 0) * 100)}%)`);
    if (hints[id]) why.push(`camera: ${hints[id].why}`);
    return why;
  };
  const tree = open.map((p) => {
    const steps = stepsFor(p.id)
      .filter((st) => !st.startsWith("test:") || !TESTS.find((t) => `test:${t.id}` === st)?.childOnly || isChild)
      .map((st) => {
        let status: "yes" | "no" | "unclear" | "next" | "waiting" = "waiting";
        if (next?.asks === st) status = "next";
        else if (st.startsWith("test:")) {
          const r = input.tests[st.slice(5)];
          if (r) status = Object.values(r).some((v) => (v ?? 0) >= YES) ? "yes" : "no";
        } else if (known[st as FindingKey]) {
          const y = yes[st as FindingKey];
          status = y >= YES ? "yes" : y < 0.3 ? "no" : "unclear";
        }
        return { step: st, label: label(st), status };
      });
    return { id: p.id, label: p.label, probability: p.probability, openedBy: openedBy(p.id), steps };
  });
  const nextPath = open.find((p) => stepsFor(p.id).includes(next?.asks as Step));
  const why =
    !next || done
      ? null
      : advisories.some((adv) => ADVISORY_FIRST[adv.kind] === next!.asks)
        ? `Network alert: ${advisories.find((adv) => ADVISORY_FIRST[adv.kind] === next!.asks)!.source} has a cluster → screening for it first`
      : strokeRed && (next.asks?.startsWith("test:") || next.asks === "confused_speech")
        ? "Stroke signs reported → help is being called; quick bedside checks for the doctor"
      : next.asks?.startsWith("intake:") || next.asks === "open"
        ? "Getting to know the patient first: no assumptions yet"
        : next.asks === "free"
          ? "Following up on what the patient described"
        : next.asks === "history:confirm"
          ? "Checking it heard the patient right before reasoning on it"
        : next.asks?.startsWith("history:")
          ? "Understanding the problem before narrowing anything down"
          : next.english.startsWith("[hunch:")
            ? "The camera noticed something: asking instead of assuming"
        : nextPath
          ? `${nextPath.label} is open (${openedBy(nextPath.id).join(", ") || "complaint"}) → checking ${label(next.asks as Step).toLowerCase()}${stepsFor(nextPath.id).indexOf(next.asks as Step) < 2 ? " first" : ""}`
          : isChild && ["unable_to_drink", "vomits_everything", "seizure", "very_sleepy"].includes(next.asks ?? "")
            ? "Child: WHO danger signs are always checked first"
            : "Nothing specific found yet → screening";

  const redHit = ruleHits.find((h) => h.urgency === "red");
  const sure = causes.find((c) => c.confident);
  const top = redHit?.label ?? (sure ? `Most likely: ${sure.name}` : ruleHits[0]?.label ?? (complaintKnown ? "Still gathering information" : "No danger signs found so far"));
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
    intake,
    lexicon,
    tree,
    why,
    complaint_known: complaintKnown,
    network: { post: podPost, advisories: advisories.map((x) => ({ kind: x.kind, text: x.text, source: x.source })) },
    peer_group: {
      wants: yes.wants_peer_group >= YES && !facts.self_harm_thoughts,
      category: mental && mental.probability >= OPEN ? (mental.subtypes[0]?.name ?? null) : null,
    },
    jev_ms: Date.now() - t0,
  };
}

// Which condition each safety rule points to.
const RULE_CAUSE: Record<string, string> = {
  stroke_face_droop_camera: "Stroke",
  stroke_weakness_reported: "Stroke",
  stroke_speech: "Stroke",
  stroke_balance: "Stroke",
  cardiac_chest_pain: "Heart attack",
  severe_pneumonia: "Severe pneumonia",
  pneumonia: "Pneumonia",
  suicide_risk: "Suicide risk",
  spinal_cord: "Spinal cord compression",
  pregnancy_danger: "Pre-eclampsia",
  thunderclap_headache: "Bleeding in the brain",
  low_oxygen: "Severe pneumonia",
  low_sugar: "Low blood sugar",
  meningitis_signs: "Meningitis",
  dehydration: "Some dehydration",
  dysentery: "Dysentery",
  kidney_infection: "Kidney infection",
};

const UNSURE = "Not sure yet";
const URGENCY_RANK_LOCAL: Record<Urgency, number> = { green: 0, yellow: 1, red: 2 };
const ADVISORY_FIRST: Record<"malaria" | "diarrhea" | "respiratory", FindingKey> = { malaria: "fever", diarrhea: "diarrhea", respiratory: "cough" };
const CONFIDENT = 0.7;

const HELP_NOW = { en: "We are calling for help now. While it comes, let's do a few quick checks.", es: "Ya estamos pidiendo ayuda. Mientras llega, hagamos unas pruebas rápidas." };
const SPEECH_AGAIN = { en: "This is just a quick speech check: please say these exact words back to me:", es: "Es solo una prueba rápida del habla: por favor repita exactamente estas palabras:" };
const RETELL = { en: "Sorry, I didn't catch that well. Could you tell me again, in other words, what is bothering you?", es: "Perdón, no le entendí bien. ¿Me puede contar otra vez, con otras palabras, qué es lo que más le molesta?" };
const SORRY = { en: "Sorry, I didn't quite understand.", es: "Perdón, no le entendí bien." };
const CLARO = { en: "Of course.", es: "Claro." };
const HELP_COMING = { en: "Good question. The health worker and the doctor will explain everything to you.", es: "Buena pregunta. El promotor de salud y el doctor le van a explicar todo." };
const stripPrefix = (t: string, l: Lang) => t.replace(SORRY[l], "").replace(CLARO[l], "").trim();

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
  if (/(amoxicillin|rehydration|zinc|rapid test|pulse|glucose|blood pressure|check|paracetamol|dressing|bandage|splint|advice|antacid|review|visit|dipstick|sessions|group|circle|stays with)/.test(s)) return "on_site";
  return "drone";
}
