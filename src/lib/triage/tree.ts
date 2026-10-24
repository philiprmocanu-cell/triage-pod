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
    ask: { en: "Are you sweating a lot right now, or breaking into a cold sweat, even without heat or hard work?", es: "¿Está sudando mucho ahorita, o le da sudor frío, aunque no haga calor ni esté trabajando duro?" },
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
  // Speech test from stroke scales: repeat a simple sentence; Jev checks the transcript.
  confused_speech: {
    label: "Slurred or confused speech",
    ask: { en: "Please repeat after me: \"Today the sky is blue and the river is calm.\"", es: "Por favor, repita después de mí: \"Hoy el cielo está azul y el río está tranquilo.\"" },
  },
  headache: { label: "Headache", ask: { en: "Do you have a headache?", es: "¿Le duele la cabeza?" } },
  worst_headache: {
    label: "Sudden, worst-ever headache",
    ask: { en: "Did the headache start suddenly, like a blow, and is it the worst you have ever had?", es: "¿El dolor de cabeza empezó de golpe, como un golpe fuerte, y es el peor que ha tenido en su vida?" },
  },
  light_hurts: { label: "Light or noise hurts", ask: { en: "Does light or noise make it worse?", es: "¿La luz o el ruido le molestan más?" } },
  severe_headache: { label: "Severe headache or blurred vision", ask: { en: "Do you have a very strong headache or blurry vision?", es: "¿Tiene un dolor de cabeza muy fuerte o ve borroso?" } },
  seizure: { label: "Seizure / convulsions", ask: { en: "Has there been a seizure or shaking fit?", es: "¿Ha tenido convulsiones o ataques?" } },
  unable_to_drink: {
    label: "Cannot drink or breastfeed",
    ask: { en: "Can you drink fluids, or are you unable to keep anything down?", es: "¿Puede tomar líquidos, o no puede tomar nada?" },
    askChild: { en: "Can the child drink or breastfeed, or are they unable to?", es: "¿El niño puede tomar líquidos o mamar, o no puede?" },
  },
  vomits_everything: { label: "Vomits everything", ask: { en: "Do they vomit everything they eat or drink?", es: "¿Vomita todo lo que come o toma?" } },
  very_sleepy: {
    label: "Very sleepy or hard to wake",
    ask: { en: "Are they very sleepy or hard to wake up?", es: "¿Está muy dormido o cuesta despertarlo?" },
    seen: "Does the person look very drowsy, limp, or unable to keep their eyes open?",
  },
  fever: { label: "Fever", ask: { en: "Do you have a fever, or feel hot?", es: "¿Tiene calentura o se siente caliente?" } },
  chills: { label: "Chills, shivering then sweats", ask: { en: "Do you get chills or shivering, and then break into a sweat?", es: "¿Le dan escalofríos o temblores, y luego suda mucho?" } },
  mosquito_bites: {
    label: "Mosquito bites / no bed net",
    ask: { en: "Have you had many mosquito bites lately, or do you sleep without a mosquito net?", es: "¿Le han picado muchos zancudos últimamente, o duerme sin mosquitero?" },
    seen: "Are there visible insect bite marks (small red bumps) on the person's skin?",
  },
  belly_pain: { label: "Belly pain", ask: { en: "Do you have pain in your belly?", es: "¿Le duele la panza?" } },
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
  balance_problem: { label: "Unsteady / loss of balance", ask: { en: "Do you feel dizzy or unsteady when you walk?", es: "¿Se siente mareado o inestable al caminar?" } },
  leg_weakness: { label: "Leg weakness / hard to stand", ask: { en: "Are your legs weak, or is it hard to stand up?", es: "¿Siente las piernas débiles o le cuesta levantarse?" } },
  back_pain: { label: "Back pain", ask: { en: "Do you have pain in your back?", es: "¿Le duele la espalda?" } },
  pain_on_bending: { label: "Pain when bending", ask: { en: "Did that hurt when you bent over?", es: "¿Le dolió cuando se agachó?" } },
  bladder_control: { label: "Lost bladder or bowel control", ask: { en: "Have you lost control of your bladder or bowels?", es: "¿Ha perdido el control para orinar o hacer popó?" } },
  swollen_feet: { label: "Swelling of both feet", ask: { en: "Are both feet swollen?", es: "¿Tiene los dos pies hinchados?" } },
  // Mental health: PHQ-2 (low mood, little interest), GAD-2 (anxious, can't stop worrying),
  // and the WHO mhGAP question about thoughts of ending one's life.
  low_mood: {
    label: "Feeling down or hopeless",
    ask: { en: "In the last two weeks, have you felt down, sad or hopeless on most days?", es: "En las últimas dos semanas, ¿se ha sentido triste, decaído o sin esperanza casi todos los días?" },
    seen: "Is the person visibly crying or tearful?",
  },
  little_interest: { label: "Little interest or pleasure", ask: { en: "In the last two weeks, have you had little interest or pleasure in doing things?", es: "En las últimas dos semanas, ¿ha tenido poco interés o gusto en hacer las cosas?" } },
  anxious: { label: "Nervous or on edge", ask: { en: "Have you felt nervous, anxious or on edge on most days?", es: "¿Se ha sentido nervioso, ansioso o con los nervios de punta casi todos los días?" } },
  cant_stop_worrying: { label: "Can't stop worrying", ask: { en: "Have you been unable to stop or control worrying?", es: "¿No ha podido dejar de preocuparse?" } },
  self_harm_thoughts: {
    label: "Thoughts of ending their life",
    ask: { en: "Sometimes when people feel this way, they think about ending their life. Have you had thoughts like that?", es: "A veces, cuando uno se siente así, piensa en quitarse la vida. ¿Ha tenido pensamientos así?" },
  },
  trauma_or_loss: { label: "Recent loss, violence or hardship", ask: { en: "Has something very hard happened recently, like a loss or violence?", es: "¿Le ha pasado algo muy difícil últimamente, como una pérdida o violencia?" } },
  // Loneliness: the short UCLA loneliness questions, asked plainly.
  lonely: {
    label: "Lonely or isolated",
    ask: { en: "How often do you feel alone, left out, or without people to talk to?", es: "¿Qué tan seguido se siente solo, apartado o sin con quién platicar?" },
  },
  wants_peer_group: {
    label: "Wants a peer support group",
    ask: {
      en: "There are people near you who meet regularly to talk and support each other, with a trained counselor. Would you like the health worker to introduce you?",
      es: "Cerca de usted hay personas que se juntan seguido para platicar y apoyarse, con un consejero. ¿Le gustaría que el promotor de salud le presente con ellos?",
    },
  },
} as const satisfies Record<string, { label: string; ask: Text; askChild?: Text; seen?: string }>;

export type FindingKey = keyof typeof FINDINGS;
export const FINDING_KEYS = Object.keys(FINDINGS) as FindingKey[];

export type Subtype = { name: string; description: string; urgency: Urgency; resources: string[] };

export type Pathway = {
  id: string;
  label: string;
  description: string; // for Jev's chief-complaint choice
  triggers: FindingKey[]; // any of these opens the pathway
  questions: Step[]; // questions and physical tests, in this order: danger signs first
  subtypes: Subtype[];
};

export const PATHWAYS: Pathway[] = [
  {
    id: "stroke",
    label: "Stroke / brain",
    description: "Face drooping, one-sided weakness or numbness, slurred speech, sudden confusion",
    triggers: ["face_or_arm_weakness", "confused_speech", "balance_problem"],
    questions: ["test:smile", "face_or_arm_weakness", "test:arm_drift", "confused_speech", "sudden_onset", "test:walk_line", "severe_headache"],
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
    questions: ["test:chest_show", "chest_indrawing", "unable_to_drink", "fast_breathing", "short_of_breath", "fever", "wheeze", "long_cough"],
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
    triggers: ["fever", "chills"],
    questions: ["very_sleepy", "seizure", "unable_to_drink", "stiff_neck", "chills", "mosquito_bites", "rash", "yellow_eyes", "test:palms", "vomits_everything"],
    subtypes: [
      { name: "Severe malaria", description: "Fever (often with chills, mosquito bites or no bed net) plus convulsions, very sleepy, cannot drink, yellow eyes or very pale", urgency: "red", resources: ["Malaria rapid test", "Rectal artesunate (pre-referral)", "Urgent referral"] },
      { name: "Meningitis", description: "Fever with stiff neck, severe headache, rash or confusion", urgency: "red", resources: ["Pre-referral antibiotic dose", "Urgent referral"] },
      { name: "Malaria", description: "Fever with chills and sweats, often after many mosquito bites or sleeping without a net, in a malaria area, without danger signs", urgency: "yellow", resources: ["Malaria rapid test", "Artemisinin combination therapy"] },
      { name: "Dengue", description: "Fever with rash, body and eye pain, in a dengue area", urgency: "yellow", resources: ["Paracetamol (no ibuprofen)", "Oral rehydration salts", "Doctor review"] },
      { name: "Viral fever", description: "Fever with no danger signs and no specific pattern", urgency: "green", resources: ["Paracetamol", "Malaria rapid test"] },
    ],
  },
  {
    id: "stomach",
    label: "Diarrhea / vomiting",
    description: "Diarrhea, vomiting, stomach upset",
    triggers: ["diarrhea", "vomits_everything", "belly_pain"],
    questions: ["unable_to_drink", "very_sleepy", "sunken_eyes", "blood_in_stool", "vomits_everything", "diarrhea", "fever", "test:feet"],
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
    questions: ["severe_bleeding", "severe_headache", "seizure", "test:feet", "fever"],
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
  {
    id: "headache",
    label: "Headache",
    description: "Headache, head pain, migraine",
    triggers: ["headache", "worst_headache"],
    questions: ["worst_headache", "fever", "stiff_neck", "chills", "mosquito_bites", "face_or_arm_weakness", "light_hurts", "severe_headache", "pregnant"],
    subtypes: [
      { name: "Bleeding in the brain", description: "Sudden, worst-ever headache, maybe with vomiting or confusion", urgency: "red", resources: ["Emergency transport to hospital with CT"] },
      { name: "Meningitis", description: "Headache with fever and stiff neck, maybe rash or confusion", urgency: "red", resources: ["Pre-referral antibiotic dose", "Urgent referral"] },
      { name: "High blood pressure", description: "Headache with blurred vision, older age or known high pressure", urgency: "yellow", resources: ["Blood pressure check", "Doctor review"] },
      { name: "Fever headache (malaria or infection)", description: "Headache with fever, no stiff neck", urgency: "yellow", resources: ["Malaria rapid test", "Paracetamol"] },
      { name: "Migraine", description: "Throbbing headache, light hurts, maybe nausea, has happened before", urgency: "green", resources: ["Paracetamol", "Home care advice"] },
      { name: "Tension headache", description: "Pressing headache from stress, tiredness or not eating, no danger signs", urgency: "green", resources: ["Paracetamol", "Home care advice"] },
    ],
  },
  {
    id: "pain",
    label: "Back / joint pain",
    description: "Back pain, joint pain, pain when moving or bending, weak legs",
    triggers: ["back_pain", "pain_on_bending", "leg_weakness"],
    questions: ["bladder_control", "leg_weakness", "test:squat", "test:bend", "pain_on_bending", "fever", "injury"],
    subtypes: [
      { name: "Spinal cord compression", description: "Back pain with leg weakness or loss of bladder/bowel control", urgency: "red", resources: ["Emergency transport", "Urgent referral"] },
      { name: "Kidney infection", description: "Back or side pain with fever", urgency: "yellow", resources: ["Urine dipstick", "Antibiotic (doctor to choose)", "Doctor review"] },
      { name: "Sciatica / nerve pain", description: "Pain shooting down one leg, worse on bending", urgency: "yellow", resources: ["Paracetamol", "Doctor review"] },
      { name: "Possible fracture", description: "Pain after a fall, cannot bear weight", urgency: "yellow", resources: ["Splint", "Doctor review"] },
      { name: "Muscle strain", description: "Back pain after lifting or work, moves normally", urgency: "green", resources: ["Paracetamol", "Home care advice"] },
    ],
  },
  {
    id: "mental",
    label: "Mental health",
    description: "Sadness, worry, stress, trouble sleeping, grief, loneliness or feeling alone, thoughts of self-harm",
    triggers: ["low_mood", "little_interest", "anxious", "cant_stop_worrying", "self_harm_thoughts", "trauma_or_loss", "lonely"],
    questions: ["low_mood", "little_interest", "self_harm_thoughts", "anxious", "cant_stop_worrying", "trauma_or_loss", "lonely", "wants_peer_group"],
    subtypes: [
      { name: "Suicide risk", description: "Thoughts of ending their life or self-harm", urgency: "red", resources: ["Health worker stays with the patient now", "Same-day mental health referral"] },
      { name: "Depression", description: "Low mood or loss of interest on most days for two weeks or more", urgency: "yellow", resources: ["Problem-solving sessions (Friendship Bench model)", "Peer support group (opt-in)", "Doctor review"] },
      { name: "Anxiety", description: "Nervous, on edge, cannot stop worrying on most days", urgency: "yellow", resources: ["Problem-solving sessions (Friendship Bench model)", "Peer support group (opt-in)"] },
      { name: "Stress or grief reaction", description: "Distress after a recent loss, violence or hardship", urgency: "green", resources: ["Peer support group (opt-in)", "Follow-up visit"] },
      { name: "Loneliness", description: "Feels alone or cut off from people, without low mood most days", urgency: "green", resources: ["Community circle (opt-in)", "Follow-up visit"] },
    ],
  },
];

// Physical tests, adapted from standard bedside exams so a camera can watch them:
// smile + arm drift (Cincinnati Prehospital Stroke Scale), heel-to-toe walk (balance, the "B" in
// BE-FAST), crouch and forward bend (back/leg pain), and the WHO IMCI "look" signs (chest
// indrawing, palm pallor, pitting swelling of both feet). Jev watches a sequence of pictures.
export type Test = {
  id: string;
  label: string;
  say: Text;
  prep: number; // seconds to get into position before watching starts
  seconds: number;
  childOnly?: boolean;
  checks: { finding: FindingKey; question: string }[]; // Jev yes/no over the picture sequence
};

export const TESTS: Test[] = [
  {
    id: "finger",
    label: "Oxygen + pulse (finger sensor)",
    say: { en: "Please rest your index finger on the red sensor and keep still for fifteen seconds.", es: "Por favor, ponga su dedo índice sobre el sensor rojo y no lo mueva por quince segundos." },
    prep: 1,
    seconds: 15,
    checks: [], // measured by the pod's sensor, not judged from pictures
  },
  {
    id: "smile",
    label: "Smile test",
    say: { en: "Please give me a big smile, showing your teeth.", es: "Por favor, sonría grande, enseñando los dientes." },
    prep: 1,
    seconds: 3,
    checks: [{ finding: "face_or_arm_weakness", question: "When the person smiles, does one side of the mouth lift clearly less than the other side?" }],
  },
  {
    id: "arm_drift",
    label: "Arm drift test",
    say: { en: "Close your eyes and hold both arms straight out in front of you, palms up, until I say stop.", es: "Cierre los ojos y estire los dos brazos al frente, con las palmas hacia arriba, hasta que le diga." },
    prep: 2,
    seconds: 8,
    checks: [{ finding: "face_or_arm_weakness", question: "Does one arm drift downward or turn over compared with the other arm?" }],
  },
  {
    id: "walk_line",
    label: "Heel-to-toe walk",
    say: {
      en: "With the health worker beside you, please stand up and walk toward me in a straight line, heel to toe.",
      es: "Con el promotor de salud a su lado, levántese y camine hacia mí en línea recta, poniendo un pie delante del otro.",
    },
    prep: 4,
    seconds: 8,
    checks: [
      { finding: "balance_problem", question: "Does the person lose balance, stagger, step off the line, or reach out for support?" },
      { finding: "leg_weakness", question: "Does the person limp or drag or favour one leg?" },
    ],
  },
  {
    id: "squat",
    label: "Crouch and stand",
    say: { en: "Please crouch down slowly, then stand back up.", es: "Por favor, agáchese despacio y luego levántese." },
    prep: 2,
    seconds: 6,
    checks: [
      { finding: "leg_weakness", question: "Does the person struggle to get up, need to hold on to something, or fail to crouch?" },
      { finding: "pain_on_bending", question: "Does the person's face show pain (grimace, wince) while crouching or standing up?" },
    ],
  },
  {
    id: "bend",
    label: "Forward bend",
    say: { en: "Please bend forward slowly, as if to touch your toes, then stand up.", es: "Por favor, dóblese hacia adelante despacio, como para tocarse los pies, y luego enderécese." },
    prep: 2,
    seconds: 6,
    checks: [{ finding: "pain_on_bending", question: "Does the person stop early, grimace in pain, or hold their back while bending?" }],
  },
  {
    id: "chest_show",
    label: "Chest check (child)",
    say: { en: "Please lift the child's shirt so I can see the chest and belly while they breathe calmly.", es: "Por favor, levántele la camisa al niño para ver el pecho y la panza mientras respira tranquilo." },
    prep: 4,
    seconds: 8,
    childOnly: true,
    checks: [
      { finding: "chest_indrawing", question: "Does the skin below the child's ribs pull inward when the child breathes in (chest indrawing)?" },
      { finding: "fast_breathing", question: "Is the child's chest or belly moving up and down very fast?" },
    ],
  },
  {
    id: "palms",
    label: "Palm check",
    say: { en: "Please hold both hands open toward the camera, palms facing me.", es: "Por favor, muestre las dos manos abiertas hacia la cámara, con las palmas hacia mí." },
    prep: 1,
    seconds: 3,
    checks: [{ finding: "pale", question: "Are the palms of the hands very pale, almost white, compared with normal skin?" }],
  },
  {
    id: "feet",
    label: "Foot swelling check",
    say: { en: "Please press your thumb on the top of each foot for three seconds, then show the feet to the camera.", es: "Por favor, apriete con el dedo encima de cada pie por tres segundos y luego muestre los pies a la cámara." },
    prep: 5,
    seconds: 8,
    checks: [{ finding: "swollen_feet", question: "Are both feet swollen, or does a dent stay in the skin after pressing (pitting)?" }],
  },
];
export type TestId = (typeof TESTS)[number]["id"];

// Before any medical question: who the patient is. Saved only with consent.
export const INTAKE = {
  // Greeting in both languages: the patient's answer tells the pod which one to continue in.
  name: { en: "Hello, I'm the health pod. What's your name?", es: "Hola, soy el asistente de salud. ¿Cómo se llama? Hello, what's your name?" },
  community: { en: "Where do you live?", es: "¿En qué comunidad o lugar vive?" },
  who: { en: "Is this visit for you or for someone else, like a child? How old are they?", es: "¿La consulta es para usted o para otra persona, como un niño? ¿Qué edad tiene?" },
  consent: {
    en: "May we save your name and what you need, so the health team can help you? Only the health team will see it.",
    es: "¿Está de acuerdo en que guardemos su nombre y lo que necesita, para que el equipo de salud le pueda ayudar? Solo el equipo de salud lo verá.",
  },
} as const;
export type IntakeField = keyof typeof INTAKE;
export const INTAKE_FIELDS = Object.keys(INTAKE) as IntakeField[];

// One step of the visit: a finding question, a physical test, or an intake question.
export type Step = FindingKey | `test:${string}` | `intake:${IntakeField}` | `history:${HistoryField}` | "open" | "free";

export const OPENING: Text = {
  en: "Thank you. What brings you in today? Tell me what is bothering you the most.",
  es: "Gracias. ¿Qué le trae hoy por aquí? Cuénteme qué es lo que más le molesta.",
};

// After the main complaint, a nurse's history questions, before any narrowing down.
export const HISTORY = {
  // Text comes from Claude's paraphrase of what the patient said; this is the fallback.
  confirm: { en: "Let me check I understood you correctly. Is that right?", es: "Déjeme ver si le entendí bien. ¿Es así?" },
  onset: { en: "Since when have you felt like this?", es: "¿Desde cuándo se siente así?" },
  impact: { en: "How is this affecting your day? Is there anything you can't do because of it?", es: "¿Cómo le está afectando en su día? ¿Hay algo que no pueda hacer por esto?" },
  severity: { en: "From 1 to 10, how strong is it right now?", es: "Del 1 al 10, ¿qué tan fuerte es ahorita?" },
  else: { en: "Is there anything else that worries you, or anything else you feel?", es: "¿Hay algo más que le preocupe o que sienta?" },
} as const;
export type HistoryField = keyof typeof HISTORY;

export const CLOSING: Record<Urgency, Text> = {
  red: {
    en: "Stay calm. We are calling the doctor and getting you help right now. Please stay here with the health worker.",
    es: "Mantenga la calma. Ya estamos llamando al doctor y consiguiendo ayuda. Quédese aquí con el promotor de salud, por favor.",
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

// Closing when nothing was found and nothing is needed.
export const CLOSING_WELL: Text = {
  en: "Thank you. Nothing worrying came up today, and you don't need any treatment right now.",
  es: "Gracias. Hoy no encontramos nada preocupante, y por ahora no necesita ningún tratamiento.",
};

// Closing when someone has said they have thought about ending their life: warm, not alarming.
export const CLOSING_SUICIDE_RISK: Text = {
  en: "Thank you for trusting me with this. You are not alone. The health worker will stay with you right now, and we will get you support today.",
  es: "Gracias por contarme esto. No está solo ni sola. El promotor de salud se va a quedar con usted ahorita, y hoy mismo le vamos a conseguir apoyo.",
};

// Opening line when the camera already saw something worrying.
export const SEEN_OPENERS: Partial<Record<FindingKey, Text>> = {
  face_or_arm_weakness: { en: "I can see one side of your face looks different. Is one side of your face or an arm weak or numb?", es: "Veo que un lado de su cara se ve diferente. ¿Tiene un lado de la cara o un brazo débil o dormido?" },
  sweating: { en: "I can see you are sweating. Are you sweating a lot right now, even without heat or hard work?", es: "Veo que está sudando. ¿Está sudando mucho ahorita, aunque no haga calor ni esté trabajando duro?" },
  short_of_breath: { en: "It looks hard for you to breathe. Is it hard to breathe right now?", es: "Parece que le cuesta respirar. ¿Le cuesta respirar ahorita?" },
  severe_bleeding: { en: "I can see bleeding. Is it heavy and not stopping?", es: "Veo sangre. ¿Está sangrando mucho y no para?" },
  yellow_eyes: { en: "Your eyes look a little yellow. Have you had a fever?", es: "Sus ojos se ven un poco amarillos. ¿Ha tenido calentura?" },
  low_mood: { en: "You seem upset, and that's okay. In the last two weeks, have you felt down, sad or hopeless on most days?", es: "Le veo afligido, y está bien. En las últimas dos semanas, ¿se ha sentido triste, decaído o sin esperanza casi todos los días?" },
};
// Which finding an opener asks about (so it is not asked twice).
export const SEEN_OPENER_ASKS: Partial<Record<FindingKey, Step>> = {
  face_or_arm_weakness: "face_or_arm_weakness",
  sweating: "sweating", // confirm the sign first; the chest question follows once the complaint is known
  short_of_breath: "short_of_breath",
  severe_bleeding: "severe_bleeding",
  yellow_eyes: "fever",
  low_mood: "low_mood",
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
