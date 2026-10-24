// The triage tree. Step 1: Jev looks at the patient. Step 2: what it sees plus what the patient
// says open one or more "pathways" (chest, breathing, fever...). Step 3: each pathway has its own
// follow-up questions, asked in order of danger, skipping anything already seen or answered.
// Step 4: within each pathway Jev sub-classifies the likely condition with probabilities.

import type { Urgency } from "./types";

export type Lang = "es" | "en";
type Text = Record<Lang, string>;

// Everything the pod tracks about the patient. `ask` is the follow-up question; `seen` is what
// Jev checks for in the camera picture (only signs a webcam can plausibly show).
export const FINDINGS = {
  chest_pain: { label: "Chest pain or pressure", ask: { en: "Do you have pain or pressure in your chest?", es: "¿Siente dolor o presión en el pecho?" } },
  pain_spreads: { label: "Pain spreads to arm, jaw or back", ask: { en: "Does the pain move to your arm, jaw or back?", es: "¿El dolor se le pasa al brazo, la quijada o la espalda?" } },
  sweating: {
    label: "Sweating or clammy",
    ask: { en: "Are you sweating or feeling cold and clammy?", es: "¿Está sudando o siente sudor frío?" },
    seen: "Is the person's face visibly sweaty, wet or shiny with sweat?",
  },
  short_of_breath: {
    label: "Short of breath",
    ask: { en: "Is it hard to breathe right now?", es: "¿Le cuesta respirar ahorita?" },
    seen: "Does the person look like they are struggling to breathe (mouth open gasping, straining neck, distressed breathing)?",
  },
  sudden_onset: { label: "Started suddenly", ask: { en: "Did this start suddenly, within the last few hours?", es: "¿Esto empezó de repente, en las últimas horas?" } },
  face_or_arm_weakness: {
    label: "Face or arm weakness",
    ask: { en: "Is one side of your face or one arm weak or numb?", es: "¿Tiene un lado de la cara o un brazo débil o dormido?" },
    seen: "Is one side of the person's face drooping compared with the other side (mouth corner or eyelid lower on one side)?",
  },
  confused_speech: { label: "Slurred or confused speech", ask: { en: "Has your speech changed, or do words come out wrong?", es: "¿Siente que habla raro o que no le salen bien las palabras?" } },
  severe_headache: { label: "Severe headache or blurred vision", ask: { en: "Do you have a very strong headache or blurry vision?", es: "¿Tiene un dolor de cabeza muy fuerte o ve borroso?" } },
  seizure: { label: "Seizure / convulsions", ask: { en: "Has there been a seizure or shaking fit?", es: "¿Ha tenido convulsiones o ataques?" } },
  unable_to_drink: { label: "Cannot drink or breastfeed", ask: { en: "Can they drink or breastfeed, or are they unable to?", es: "¿Puede tomar líquidos o mamar, o no puede?" } },
  vomits_everything: { label: "Vomits everything", ask: { en: "Do they vomit everything they eat or drink?", es: "¿Vomita todo lo que come o toma?" } },
  very_sleepy: {
    label: "Very sleepy or hard to wake",
    ask: { en: "Are they very sleepy or hard to wake up?", es: "¿Está muy dormido o cuesta despertarlo?" },
    seen: "Does the person look very drowsy, limp, or unable to keep their eyes open?",
  },
  fever: { label: "Fever", ask: { en: "Do you have a fever, or feel hot?", es: "¿Tiene calentura o se siente caliente?" } },
  stiff_neck: { label: "Stiff neck", ask: { en: "Does it hurt to bend your neck forward?", es: "¿Le duele al doblar el cuello hacia adelante?" } },
  rash: { label: "Rash or spots", ask: { en: "Is there a rash or red spots on the skin?", es: "¿Tiene ronchas o manchas rojas en la piel?" }, seen: "Is there a visible rash or many red spots on the person's skin?" },
  cough: { label: "Cough", ask: { en: "Do you have a cough?", es: "¿Tiene tos?" } },
  long_cough: { label: "Cough for more than 2 weeks", ask: { en: "Have you been coughing for more than two weeks?", es: "¿Tiene más de dos semanas con tos?" } },
  fast_breathing: { label: "Fast breathing", ask: { en: "Is the breathing faster than normal?", es: "¿Respira más rápido de lo normal?" } },
  chest_indrawing: { label: "Chest indrawing", ask: { en: "When breathing in, does the skin pull in under the ribs?", es: "¿Al respirar se le hunde la piel debajo de las costillas?" } },
  wheeze: { label: "Wheezing", ask: { en: "Is there a whistling sound when breathing?", es: "¿Le silba el pecho al respirar?" } },
  diarrhea: { label: "Diarrhea", ask: { en: "Is there diarrhea?", es: "¿Tiene diarrea?" } },
  sunken_eyes: {
    label: "Sunken eyes / very thirsty",
    ask: { en: "Are the eyes sunken, or are they very thirsty?", es: "¿Tiene los ojos hundidos o mucha sed?" },
    seen: "Do the person's eyes look sunken into the face?",
  },
  blood_in_stool: { label: "Blood in stool", ask: { en: "Is there blood in the stool?", es: "¿Hay sangre en el popó?" } },
  pregnant: { label: "Pregnant", ask: { en: "Are you pregnant?", es: "¿Está embarazada?" } },
  severe_bleeding: {
    label: "Heavy bleeding",
    ask: { en: "Is there heavy bleeding that won't stop?", es: "¿Está sangrando mucho y no para?" },
    seen: "Is there visible blood or an actively bleeding wound?",
  },
  injury: { label: "Injury", ask: { en: "Were you hurt in an accident or a fall?", es: "¿Se lastimó en un accidente o una caída?" }, seen: "Is there a visible wound, cut, bruise or deformed limb?" },
  yellow_eyes: { label: "Yellow eyes or skin", ask: { en: "Are the eyes or skin yellow?", es: "¿Tiene los ojos o la piel amarillos?" }, seen: "Are the whites of the person's eyes or their skin yellow?" },
  pale: { label: "Very pale", ask: { en: "Have you been very pale or tired lately?", es: "¿Ha estado muy pálido o cansado últimamente?" }, seen: "Does the person look unusually pale (very pale lips or face)?" },
  blue_lips: { label: "Blue lips", ask: { en: "Are the lips or fingertips turning blue?", es: "¿Se le ponen morados los labios o las uñas?" }, seen: "Are the person's lips bluish or grey?" },
  very_thin: { label: "Very thin / wasting", ask: { en: "Has there been a lot of weight loss?", es: "¿Ha bajado mucho de peso?" }, seen: "Does the person look severely underweight or wasted?" },
} as const satisfies Record<string, { label: string; ask: Text; seen?: string }>;

export type FindingKey = keyof typeof FINDINGS;
export const FINDING_KEYS = Object.keys(FINDINGS) as FindingKey[];

export type Subtype = { name: string; description: string; urgency: Urgency; resources: string[] };

export type Pathway = {
  id: string;
  label: string;
  description: string; // for Jev's chief-complaint choice
  triggers: FindingKey[]; // any of these opens the pathway
  questions: FindingKey[]; // asked in this order: danger signs first
  subtypes: Subtype[];
};

export const PATHWAYS: Pathway[] = [
  {
    id: "stroke",
    label: "Stroke / brain",
    description: "Face drooping, one-sided weakness or numbness, slurred speech, sudden confusion",
    triggers: ["face_or_arm_weakness", "confused_speech"],
    questions: ["face_or_arm_weakness", "confused_speech", "sudden_onset", "severe_headache"],
    subtypes: [
      { name: "Stroke", description: "Sudden face droop, arm weakness or speech trouble", urgency: "red", resources: ["Emergency transport to hospital with CT", "Blood glucose check"] },
      { name: "Low blood sugar", description: "Confusion or weakness in a diabetic or someone who has not eaten", urgency: "red", resources: ["Blood glucose check", "Oral glucose"] },
      { name: "Bell's palsy", description: "Only the face is weak, came on over a day, no arm or speech problem", urgency: "yellow", resources: ["Doctor review"] },
      { name: "Migraine", description: "Headache with temporary vision or sensation changes, history of similar episodes", urgency: "green", resources: ["Paracetamol"] },
    ],
  },
  {
    id: "cardiac",
    label: "Chest pain / heart",
    description: "Chest pain, chest pressure or tightness",
    triggers: ["chest_pain"],
    questions: ["pain_spreads", "sweating", "short_of_breath", "sudden_onset"],
    subtypes: [
      { name: "Heart attack", description: "Crushing or pressure pain, spreading to arm/jaw, sweating, breathlessness", urgency: "red", resources: ["Emergency transport", "Aspirin (doctor to approve)", "ECG at receiving clinic"] },
      { name: "Angina", description: "Chest pain on exertion that settles with rest", urgency: "yellow", resources: ["Doctor review", "ECG at receiving clinic"] },
      { name: "Chest infection", description: "Chest pain with cough and fever", urgency: "yellow", resources: ["Amoxicillin", "Pulse oximeter check"] },
      { name: "Muscle or reflux pain", description: "Pain that changes with movement, pressing, or after meals", urgency: "green", resources: ["Paracetamol", "Antacid"] },
    ],
  },
  {
    id: "breathing",
    label: "Breathing / cough",
    description: "Cough, fast or difficult breathing, wheezing",
    triggers: ["cough", "short_of_breath", "fast_breathing", "wheeze"],
    questions: ["chest_indrawing", "unable_to_drink", "fast_breathing", "short_of_breath", "fever", "wheeze", "long_cough"],
    subtypes: [
      { name: "Severe pneumonia", description: "Chest indrawing, cannot drink, very sleepy, or blue lips with cough or fast breathing", urgency: "red", resources: ["Pulse oximeter check", "Oxygen", "Pre-referral antibiotic dose", "Urgent referral"] },
      { name: "Pneumonia", description: "Cough with fast breathing, often fever, no danger signs", urgency: "yellow", resources: ["Amoxicillin", "Pulse oximeter check"] },
      { name: "Asthma attack", description: "Wheezing and breathlessness, often known asthma", urgency: "yellow", resources: ["Salbutamol inhaler", "Pulse oximeter check"] },
      { name: "Tuberculosis (suspected)", description: "Cough for more than 2 weeks, weight loss, night sweats", urgency: "yellow", resources: ["Sputum test (GeneXpert)", "Doctor review"] },
      { name: "Common cold", description: "Cough or runny nose, normal breathing, no danger signs", urgency: "green", resources: ["Paracetamol", "Home care advice"] },
    ],
  },
  {
    id: "fever",
    label: "Fever",
    description: "Fever, feeling hot, chills",
    triggers: ["fever"],
    questions: ["very_sleepy", "seizure", "unable_to_drink", "stiff_neck", "rash", "yellow_eyes", "vomits_everything"],
    subtypes: [
      { name: "Severe malaria", description: "Fever with convulsions, very sleepy, cannot drink, yellow eyes or very pale", urgency: "red", resources: ["Malaria rapid test", "Rectal artesunate (pre-referral)", "Urgent referral"] },
      { name: "Meningitis", description: "Fever with stiff neck, severe headache, rash or confusion", urgency: "red", resources: ["Pre-referral antibiotic dose", "Urgent referral"] },
      { name: "Malaria", description: "Fever in a malaria area without danger signs", urgency: "yellow", resources: ["Malaria rapid test", "Artemisinin combination therapy"] },
      { name: "Dengue", description: "Fever with rash, body and eye pain, in a dengue area", urgency: "yellow", resources: ["Paracetamol (no ibuprofen)", "Oral rehydration salts", "Doctor review"] },
      { name: "Viral fever", description: "Fever with no danger signs and no specific pattern", urgency: "green", resources: ["Paracetamol", "Malaria rapid test"] },
    ],
  },
  {
    id: "stomach",
    label: "Diarrhea / vomiting",
    description: "Diarrhea, vomiting, stomach upset",
    triggers: ["diarrhea", "vomits_everything"],
    questions: ["unable_to_drink", "very_sleepy", "sunken_eyes", "blood_in_stool", "vomits_everything"],
    subtypes: [
      { name: "Severe dehydration", description: "Very sleepy, cannot drink, sunken eyes", urgency: "red", resources: ["IV fluids (referral)", "Oral rehydration salts", "Urgent referral"] },
      { name: "Some dehydration", description: "Sunken eyes or very thirsty, still drinking", urgency: "yellow", resources: ["Oral rehydration salts", "Zinc"] },
      { name: "Dysentery", description: "Blood in the stool", urgency: "yellow", resources: ["Antibiotic (doctor to choose)", "Oral rehydration salts"] },
      { name: "Diarrhea without dehydration", description: "Loose stools, drinking normally, alert", urgency: "green", resources: ["Oral rehydration salts", "Zinc"] },
    ],
  },
  {
    id: "pregnancy",
    label: "Pregnancy",
    description: "Pregnant woman with a problem",
    triggers: ["pregnant"],
    questions: ["severe_bleeding", "severe_headache", "seizure", "fever"],
    subtypes: [
      { name: "Bleeding in pregnancy", description: "Heavy vaginal bleeding", urgency: "red", resources: ["Emergency transport", "Blood (drone)", "Urgent referral to maternity unit"] },
      { name: "Pre-eclampsia", description: "Severe headache, blurred vision, swelling or fits in pregnancy", urgency: "red", resources: ["Blood pressure check", "Urgent referral to maternity unit"] },
      { name: "Infection in pregnancy", description: "Fever in pregnancy", urgency: "yellow", resources: ["Malaria rapid test", "Doctor review"] },
      { name: "Routine pregnancy concern", description: "No danger signs", urgency: "green", resources: ["Antenatal visit"] },
    ],
  },
  {
    id: "injury",
    label: "Injury / bleeding",
    description: "Wound, fall, accident, bleeding",
    triggers: ["injury", "severe_bleeding"],
    questions: ["severe_bleeding", "very_sleepy", "short_of_breath"],
    subtypes: [
      { name: "Major bleeding", description: "Bleeding that will not stop, or a large wound", urgency: "red", resources: ["Pressure bandage", "Emergency transport", "Blood (drone)"] },
      { name: "Possible fracture", description: "Deformed or very painful limb after a fall", urgency: "yellow", resources: ["Splint", "Doctor review"] },
      { name: "Wound needing care", description: "Cut that needs cleaning or closing", urgency: "yellow", resources: ["Wound dressing kit", "Tetanus vaccine"] },
      { name: "Minor injury", description: "Small cut or bruise", urgency: "green", resources: ["Wound dressing kit"] },
    ],
  },
];

export const OPENING: Text = {
  en: "Hello, I'm here to help. What is bothering you today?",
  es: "Hola, estoy aquí para ayudarle. ¿Qué le pasa hoy?",
};

export const CLOSING: Record<Urgency, Text> = {
  red: {
    en: "Stay calm. We are calling the doctor and arranging transport right now. Please stay seated.",
    es: "Tranquilo. Ya estamos llamando al doctor y consiguiendo transporte. Quédese sentado, por favor.",
  },
  yellow: {
    en: "Thank you. The health worker will start treatment, and a doctor will review your case today.",
    es: "Gracias. El promotor de salud le va a dar tratamiento, y un doctor va a revisar su caso hoy.",
  },
  green: {
    en: "Thank you. The health worker will give you what you need here.",
    es: "Gracias. El promotor de salud le va a dar lo que necesita aquí.",
  },
};

// Opening line when the camera already saw something worrying.
export const SEEN_OPENERS: Partial<Record<FindingKey, Text>> = {
  face_or_arm_weakness: { en: "I can see one side of your face looks different. Is one side of your face or an arm weak or numb?", es: "Veo que un lado de su cara se ve diferente. ¿Tiene un lado de la cara o un brazo débil o dormido?" },
  sweating: { en: "I can see you are sweating. Do you have pain or pressure in your chest?", es: "Veo que está sudando. ¿Siente dolor o presión en el pecho?" },
  short_of_breath: { en: "It looks hard for you to breathe. Is it hard to breathe right now?", es: "Parece que le cuesta respirar. ¿Le cuesta respirar ahorita?" },
  severe_bleeding: { en: "I can see bleeding. Is it heavy and not stopping?", es: "Veo sangre. ¿Está sangrando mucho y no para?" },
  yellow_eyes: { en: "Your eyes look a little yellow. Have you had a fever?", es: "Sus ojos se ven un poco amarillos. ¿Ha tenido calentura?" },
};
// Which finding an opener asks about (so it is not asked twice).
export const SEEN_OPENER_ASKS: Partial<Record<FindingKey, FindingKey>> = {
  face_or_arm_weakness: "face_or_arm_weakness",
  sweating: "chest_pain",
  short_of_breath: "short_of_breath",
  severe_bleeding: "severe_bleeding",
  yellow_eyes: "fever",
};

export const LOCALES = {
  "es-MX": "Mexican Spanish (ahorita, chamaco, ¿mande?, calentura, popó)",
  "es-GT": "Guatemalan Spanish (patojo, chilero, cabal, vos, calentura)",
  "es-HN": "Honduran Spanish (cipote, catracho, vos, pisto)",
  "es-SV": "Salvadoran Spanish (bicho, cipote, vos, chivo)",
  "es-NI": "Nicaraguan Spanish (chavalo, vos, tuani)",
  "es-CO": "Colombian Spanish (parce, usted for everyone, ¿qué más?)",
  "es-PE": "Peruvian Spanish (pata, chibolo, ¿ya?, Andean words)",
  "es-BO": "Bolivian Spanish (wawa, ¿no ve?, -ito endings, Quechua/Aymara words)",
  "es-EC": "Ecuadorian Spanish (guagua, chuta, ¿ya?, mande)",
  "es-ES": "Spain Spanish (vosotros, vale, tío)",
  "es-US": "Other or neutral Latin American Spanish",
  "en-US": "English",
} as const;
export type LocaleKey = keyof typeof LOCALES;
