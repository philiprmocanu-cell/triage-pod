// Hard danger-sign rules. These run in code so the AI can never talk a patient out of an
// emergency. Sources: WHO IMCI general danger signs for children, the FAST stroke check, and
// standard red flags for chest pain and pregnancy.

import { CameraSignals, Findings, RuleHit, URGENCY_RANK, Urgency } from "./types";

type Rule = {
  id: string;
  label: string;
  urgency: Urgency;
  source: "words" | "camera";
  resources: string[];
  test: (f: Findings, c: CameraSignals) => string | null; // evidence string when it fires
};

const isChild = (f: Findings) => f.age_group === "newborn" || f.age_group === "child";

const RULES: Rule[] = [
  // Stroke (FAST)
  // The pod cannot hear slurring and a webcam can misread a face, so no single camera or speech
  // signal is enough: each stroke rule needs the patient's own words or two independent checks.
  {
    id: "stroke_weakness_reported",
    label: "Possible stroke: patient reports one-sided face or arm weakness",
    urgency: "red",
    source: "words",
    resources: ["Emergency transport to hospital with CT", "Blood glucose check"],
    test: (f) => (f.weakness_reported ? "patient says one side of the face or an arm is weak or numb" : null),
  },
  {
    id: "stroke_face_droop_camera",
    label: "Possible stroke: uneven smile confirmed twice",
    urgency: "red",
    source: "camera",
    resources: ["Emergency transport to hospital with CT", "Blood glucose check"],
    test: (f, c) =>
      c.smileTest === "asymmetric" && f.face_or_arm_weakness
        ? `face tracker and Jev both saw an uneven smile${c.droop?.side ? ` (patient's ${c.droop.side} side)` : ""}`
        : null,
  },
  {
    id: "stroke_speech",
    label: "Possible stroke: garbled speech test plus another stroke sign",
    urgency: "red",
    source: "words",
    resources: ["Emergency transport to hospital with CT", "Blood glucose check"],
    test: (f) =>
      f.confused_speech && (f.sudden_onset || f.weakness_reported || f.balance_problem)
        ? ["garbled speech test", f.sudden_onset && "sudden onset", f.weakness_reported && "reported weakness", f.balance_problem && "loss of balance"].filter(Boolean).join(" + ")
        : null,
  },
  // Heart attack
  {
    id: "cardiac_chest_pain",
    label: "Possible heart attack: chest pain with warning signs",
    urgency: "red",
    source: "words",
    resources: ["Emergency transport", "Aspirin (doctor to approve)", "ECG at receiving clinic"],
    test: (f) =>
      f.chest_pain && (f.pain_spreads || f.sweating || f.short_of_breath)
        ? "chest pain + " +
          [f.pain_spreads && "spreading pain", f.sweating && "sweating", f.short_of_breath && "short of breath"]
            .filter(Boolean)
            .join(", ")
        : null,
  },
  // WHO IMCI general danger signs (children)
  {
    id: "child_danger_sign",
    label: "WHO danger sign in a child",
    urgency: "red",
    source: "words",
    resources: ["Urgent referral", "Pre-referral antibiotic dose", "Rectal artesunate if malaria area"],
    test: (f) => {
      if (!isChild(f)) return null;
      const signs = [
        f.unable_to_drink && "cannot drink/breastfeed",
        f.vomits_everything && "vomits everything",
        f.seizure && "convulsions",
        f.very_sleepy && "lethargic/unconscious",
      ].filter(Boolean);
      return signs.length ? signs.join(", ") : null;
    },
  },
  {
    id: "seizure_any_age",
    label: "Seizure",
    urgency: "red",
    source: "words",
    resources: ["Urgent referral"],
    test: (f) => (!isChild(f) && f.seizure ? "seizure reported" : null),
  },
  {
    id: "severe_pneumonia",
    label: "Severe pneumonia sign: chest indrawing",
    urgency: "red",
    source: "words",
    resources: ["Pulse oximeter check", "Oxygen", "Pre-referral antibiotic dose", "Urgent referral"],
    test: (f) => (f.chest_indrawing || f.blue_lips ? "chest indrawing or blue lips" : null),
  },
  {
    id: "severe_bleeding",
    label: "Severe bleeding",
    urgency: "red",
    source: "words",
    resources: ["Emergency transport", "Blood (drone)"],
    test: (f) => (f.severe_bleeding ? "severe bleeding reported" : null),
  },
  {
    id: "pregnancy_danger",
    label: "Pregnancy danger sign (possible pre-eclampsia)",
    urgency: "red",
    source: "words",
    resources: ["Blood pressure check", "Urgent referral to maternity unit"],
    test: (f) => (f.pregnant && f.severe_headache ? "pregnant + severe headache/blurred vision" : null),
  },
  {
    id: "thunderclap_headache",
    label: "Sudden worst-ever headache (possible bleeding in the brain)",
    urgency: "red",
    source: "words",
    resources: ["Emergency transport to hospital with CT"],
    test: (f) => (f.worst_headache ? "sudden, worst-ever headache" : null),
  },
  {
    id: "meningitis_signs",
    label: "Headache or fever with stiff neck (possible meningitis)",
    urgency: "red",
    source: "words",
    resources: ["Pre-referral antibiotic dose", "Urgent referral"],
    test: (f) => (f.stiff_neck && (f.fever || f.headache) ? "stiff neck + " + (f.fever ? "fever" : "headache") : null),
  },
  {
    id: "suicide_risk",
    label: "Thoughts of suicide or self-harm",
    urgency: "red",
    source: "words",
    resources: ["Health worker stays with the patient now", "Same-day mental health referral"],
    test: (f) => (f.self_harm_thoughts ? "said they have had thoughts of ending their life" : null),
  },
  {
    id: "stroke_balance",
    label: "Possible stroke: sudden loss of balance",
    urgency: "red",
    source: "words",
    resources: ["Emergency transport to hospital with CT", "Blood glucose check"],
    test: (f) => (f.balance_problem && f.sudden_onset && (f.weakness_reported || f.confused_speech || f.severe_headache) ? "sudden unsteadiness + another stroke sign" : null),
  },
  {
    id: "spinal_cord",
    label: "Back pain with leg weakness or loss of bladder control",
    urgency: "red",
    source: "words",
    resources: ["Emergency transport", "Urgent referral"],
    test: (f) =>
      f.back_pain && (f.leg_weakness || f.bladder_control)
        ? ["back pain", f.leg_weakness && "leg weakness", f.bladder_control && "bladder/bowel control lost"].filter(Boolean).join(" + ")
        : null,
  },
  {
    id: "child_malnutrition_oedema",
    label: "Swelling of both feet in a child (severe malnutrition sign)",
    urgency: "red",
    source: "words",
    resources: ["Urgent referral", "Therapeutic food (RUTF)"],
    test: (f) => (isChild(f) && f.swollen_feet ? "both feet swollen" : null),
  },
  // Yellow: needs treatment or a doctor today
  {
    id: "kidney_infection",
    label: "Back pain with fever (possible kidney infection)",
    urgency: "yellow",
    source: "words",
    resources: ["Urine dipstick", "Antibiotic (doctor to choose)"],
    test: (f) => (f.back_pain && f.fever ? "back pain + fever" : null),
  },
  {
    id: "low_mood_screen",
    label: "Positive depression or anxiety screen (PHQ-2 / GAD-2)",
    urgency: "yellow",
    source: "words",
    resources: ["Problem-solving sessions (Friendship Bench model)", "Peer support group (opt-in)"],
    test: (f) =>
      f.low_mood || f.little_interest || (f.anxious && f.cant_stop_worrying)
        ? [f.low_mood && "low mood", f.little_interest && "little interest", f.anxious && f.cant_stop_worrying && "constant worry"].filter(Boolean).join(", ")
        : null,
  },
  {
    id: "pneumonia",
    label: "Possible pneumonia: cough with fast breathing",
    urgency: "yellow",
    source: "words",
    resources: ["Amoxicillin", "Pulse oximeter check"],
    test: (f) => (f.cough && f.fast_breathing ? "cough + fast breathing" : null),
  },
  {
    id: "fever_malaria_test",
    label: "Fever: test for malaria",
    urgency: "yellow",
    source: "words",
    resources: ["Malaria rapid test", "Artemisinin combination therapy (if positive)"],
    test: (f) => (f.fever ? "fever reported" : null),
  },
  {
    id: "dehydration",
    label: "Diarrhea with dehydration signs",
    urgency: "yellow",
    source: "words",
    resources: ["Oral rehydration salts", "Zinc"],
    test: (f) => (f.diarrhea && f.sunken_eyes ? "diarrhea + sunken eyes/thirst" : null),
  },
  {
    id: "dysentery",
    label: "Blood in stool",
    urgency: "yellow",
    source: "words",
    resources: ["Antibiotic (doctor to choose)", "Oral rehydration salts"],
    test: (f) => (f.blood_in_stool ? "blood in stool" : null),
  },
  {
    id: "heart_rate_abnormal",
    label: "Heart rate outside normal range (camera estimate)",
    urgency: "yellow",
    source: "camera",
    resources: ["Manual pulse check"],
    test: (f, c) => {
      if (c.heartRateBpm == null || c.heartRateConfidence < 0.5) return null;
      const high = isChild(f) ? 160 : 120;
      const low = isChild(f) ? 70 : 45;
      return c.heartRateBpm > high || c.heartRateBpm < low ? `~${Math.round(c.heartRateBpm)} bpm from face video` : null;
    },
  },
];

export function runRules(findings: Findings, camera: CameraSignals): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const r of RULES) {
    const evidence = r.test(findings, camera);
    if (evidence) hits.push({ id: r.id, label: r.label, urgency: r.urgency, source: r.source, evidence, resources: r.resources });
  }
  return hits.sort((a, b) => URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency]);
}

export function maxUrgency(...levels: Urgency[]): Urgency {
  return levels.reduce((a, b) => (URGENCY_RANK[b] > URGENCY_RANK[a] ? b : a), "green");
}

// Measured vitals typed in by the health worker (pulse oximeter, thermometer, BP cuff, glucometer).
// Measurements beat anything the camera or the conversation can suggest.
export function vitalsRules(v: { spo2?: number; tempC?: number; sys?: number; dia?: number; glucose?: number }, f: Findings): RuleHit[] {
  const hits: RuleHit[] = [];
  const add = (id: string, label: string, urgency: Urgency, evidence: string, resources: string[]) =>
    hits.push({ id, label, urgency, source: "words", evidence: `measured: ${evidence}`, resources });
  if (v.spo2 != null && v.spo2 < 90) add("low_oxygen", "Low oxygen level", "red", `SpO2 ${v.spo2}%`, ["Oxygen", "Urgent referral"]);
  else if (v.spo2 != null && v.spo2 < 94) add("borderline_oxygen", "Borderline oxygen level", "yellow", `SpO2 ${v.spo2}%`, ["Pulse oximeter check", "Doctor review"]);
  if (v.tempC != null && v.tempC >= 40) add("very_high_fever", "Very high fever", "yellow", `${v.tempC} °C`, ["Paracetamol", "Malaria rapid test"]);
  if (v.sys != null && v.dia != null) {
    if (v.sys >= 160 || v.dia >= 110) add("severe_hypertension", f.pregnant ? "Severe high blood pressure in pregnancy (pre-eclampsia)" : "Severe high blood pressure", "red", `BP ${v.sys}/${v.dia}`, ["Blood pressure check", "Urgent referral"]);
    else if (v.sys >= 140 || v.dia >= 90) add("high_bp", "High blood pressure", f.pregnant ? "red" : "yellow", `BP ${v.sys}/${v.dia}`, ["Doctor review"]);
    else if (v.sys < 90) add("low_bp", "Low blood pressure (possible shock)", "red", `BP ${v.sys}/${v.dia}`, ["IV fluids (referral)", "Urgent referral"]);
  }
  if (v.glucose != null && v.glucose < 70) add("low_sugar", "Low blood sugar", "red", `glucose ${v.glucose} mg/dL`, ["Oral glucose", "Blood glucose check"]);
  else if (v.glucose != null && v.glucose > 300) add("high_sugar", "Very high blood sugar", "yellow", `glucose ${v.glucose} mg/dL`, ["Doctor review"]);
  return hits;
}
