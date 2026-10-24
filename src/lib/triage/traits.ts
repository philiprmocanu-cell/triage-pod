// Live physical scan: everything a camera can plausibly notice about a person, checked by Jev
// every few seconds over a short sequence of pictures. Traits marked `finding` count as seen
// evidence for that finding; traits marked `hint` only open a pathway so the pod asks about it
// ("you're holding your chest" -> "do you have chest pain?"), they never decide anything alone.

import type { FindingKey } from "./tree";

// `ask`: the symptom to confirm with the patient when this is noticed ("your face looks red" ->
// "do you feel hot or feverish?"). Unlike `finding`, it never counts as seen evidence.
export type Trait = { id: string; group: string; label: string; look: string; finding?: FindingKey; hint?: string; ask?: FindingKey };

export const TRAITS: Trait[] = [
  // Face and brain
  { id: "face_droop", group: "Face & brain", label: "One side of face drooping", look: "Compare the two sides of the face: is one mouth corner, cheek or eyelid clearly lower, flatter or not moving like the other side, as in Bell's palsy or a stroke?", finding: "face_or_arm_weakness" },
  { id: "eyelid_droop", group: "Face & brain", label: "Drooping eyelid", look: "Is one eyelid clearly lower than the other?" },
  { id: "gaze_off", group: "Face & brain", label: "Eyes looking to one side", look: "Are both eyes fixed hard to one side in every picture, as if they cannot look the other way (not just glancing away or looking at a screen)?", hint: "stroke" },
  { id: "confused_look", group: "Face & brain", label: "Looks confused or disoriented", look: "Does the person look confused or disoriented?", hint: "stroke" },
  { id: "slack_mouth", group: "Face & brain", label: "Mouth hanging open / drooling", look: "Is the mouth hanging open or is the person drooling?", hint: "stroke" },
  { id: "tremor", group: "Face & brain", label: "Shaking or trembling", look: "Is the person shaking or trembling?", hint: "fever", ask: "chills" },
  { id: "seizure_like", group: "Face & brain", label: "Jerking movements", look: "Are there sudden jerking movements of the face, arms or body, like a fit?", finding: "seizure" },
  // Eyes
  { id: "yellow_eyes", group: "Eyes", label: "Yellow eyes", look: "Are the whites of the eyes yellow?", finding: "yellow_eyes" },
  { id: "red_eyes", group: "Eyes", label: "Red eyes", look: "Are the eyes red or bloodshot?", hint: "fever", ask: "fever" },
  { id: "sunken_eyes", group: "Eyes", label: "Sunken eyes", look: "Do the eyes look sunken into the face?", finding: "sunken_eyes" },
  { id: "puffy_eyes", group: "Eyes", label: "Puffy, swollen eyelids", look: "Are the eyelids clearly puffy or swollen?" },
  { id: "eye_discharge", group: "Eyes", label: "Discharge from eyes", look: "Is there pus or discharge around the eyes?" },
  { id: "tearful", group: "Eyes", label: "Tearful or crying", look: "Is the person crying or visibly tearful?", finding: "low_mood" },
  { id: "eyes_closing", group: "Eyes", label: "Eyes keep closing", look: "Do the person's eyes keep closing, as if they cannot stay awake?", finding: "very_sleepy" },
  // Skin
  { id: "pale", group: "Skin", label: "Very pale", look: "Are the lips and inner eyelids almost white, much paler than this person's natural skin tone (not just bright or cold lighting)?", finding: "pale" },
  { id: "flushed", group: "Skin", label: "Flushed, red face", look: "Is the face clearly flushed bright red, as with a high fever (not ordinary skin tone or warm lighting)?", hint: "fever", ask: "fever" },
  { id: "sweaty", group: "Skin", label: "Sweaty or clammy", look: "Are there visible beads or drips of sweat on the face (not ordinary skin shine under lights)?", finding: "sweating" },
  { id: "blue_lips", group: "Skin", label: "Blue or grey lips", look: "Are the lips clearly blue or grey (not their normal pink or brown colour, not a shadow)?", finding: "blue_lips" },
  { id: "yellow_skin", group: "Skin", label: "Yellow skin", look: "Is the skin clearly yellow, like jaundice (not warm or yellow lighting)?", finding: "yellow_eyes" },
  { id: "rash", group: "Skin", label: "Rash or red spots", look: "Is there a visible rash or many red spots on the skin?", finding: "rash" },
  { id: "bite_marks", group: "Skin", label: "Insect bite marks", look: "Are there several small red bumps on the skin that look like mosquito or insect bites (not a rash, not acne)?", ask: "mosquito_bites" },
  { id: "blisters", group: "Skin", label: "Blisters or sores", look: "Are there blisters, open sores or crusted spots on the skin?" },
  { id: "bruises", group: "Skin", label: "Bruises", look: "Are there visible bruises?", finding: "injury" },
  { id: "wound", group: "Skin", label: "Cut or open wound", look: "Is there a visible cut or open wound?", finding: "injury" },
  { id: "bleeding", group: "Skin", label: "Active bleeding", look: "Is there visible blood or an actively bleeding wound?", finding: "severe_bleeding" },
  { id: "burn", group: "Skin", label: "Burn", look: "Is there a visible burn on the skin?", finding: "injury" },
  { id: "dry_lips", group: "Skin", label: "Dry, cracked lips", look: "Are the lips clearly dry, cracked or peeling?", hint: "stomach" },
  { id: "mouth_sores", group: "Skin", label: "Sores at the mouth corners", look: "Are there sores or cracks at the corners of the mouth?" },
  // Breathing
  { id: "labored", group: "Breathing", label: "Struggling to breathe", look: "Does the person look like they are struggling to breathe (gasping, straining the neck)?", finding: "short_of_breath" },
  { id: "mouth_breathing", group: "Breathing", label: "Breathing through the mouth", look: "Is the person breathing through an open mouth?", hint: "breathing", ask: "short_of_breath" },
  { id: "nostril_flare", group: "Breathing", label: "Nostrils flaring", look: "Do the nostrils flare out with each breath?", finding: "short_of_breath" },
  { id: "fast_chest", group: "Breathing", label: "Chest moving fast", look: "Is the chest or belly moving up and down fast?", finding: "fast_breathing" },
  { id: "coughing", group: "Breathing", label: "Coughing", look: "Is the person coughing in these pictures?", finding: "cough" },
  { id: "sneezing", group: "Breathing", label: "Runny nose or sneezing", look: "Does the person have a runny nose or are they sneezing?", hint: "breathing" },
  // Pain and posture
  { id: "grimace", group: "Pain & posture", label: "Face showing pain", look: "Is the person grimacing or wincing in pain?" },
  { id: "holding_chest", group: "Pain & posture", label: "Holding the chest", look: "Is the person holding or pressing on their chest?", hint: "cardiac", ask: "chest_pain" },
  { id: "holding_head", group: "Pain & posture", label: "Holding the head", look: "Is the person holding their head?", hint: "stroke", ask: "headache" },
  { id: "holding_belly", group: "Pain & posture", label: "Holding the belly", look: "Is the person holding their belly or stomach?", hint: "stomach", ask: "belly_pain" },
  { id: "holding_back", group: "Pain & posture", label: "Holding the back", look: "Is the person holding their lower back?", hint: "pain", ask: "back_pain" },
  { id: "guarding_limb", group: "Pain & posture", label: "Protecting an arm or leg", look: "Is the person protecting or holding an arm or leg still, as if injured?", hint: "injury" },
  { id: "limp_arm", group: "Pain & posture", label: "One arm hanging limp", look: "Is one arm hanging limp or not moving like the other?", finding: "face_or_arm_weakness" },
  { id: "slumped", group: "Pain & posture", label: "Slumped, can't sit up", look: "Is the person slumped over or unable to sit upright?", finding: "very_sleepy" },
  { id: "rocking", group: "Pain & posture", label: "Rocking or restless", look: "Is the person rocking back and forth or very restless?", hint: "mental" },
  // Mood and energy
  { id: "sad", group: "Mood & energy", label: "Sad expression", look: "Does the person look clearly sad or downcast (tearful, head down, mouth turned down), not just calm or neutral?", hint: "mental", ask: "low_mood" },
  { id: "anxious", group: "Mood & energy", label: "Anxious or frightened", look: "Does the person look anxious, frightened or tense?", hint: "mental", ask: "anxious" },
  { id: "flat", group: "Mood & energy", label: "Flat, no expression", look: "Is the face strikingly blank and lifeless across all the pictures (dull eyes, no movement at all), well beyond an ordinary calm, neutral or concentrating face?", hint: "mental" },
  { id: "agitated", group: "Mood & energy", label: "Agitated", look: "Does the person look agitated or angry?" },
  { id: "exhausted", group: "Mood & energy", label: "Exhausted", look: "Does the person look clearly exhausted (heavy eyelids, slumping), not just calm?" },
  { id: "drowsy", group: "Mood & energy", label: "Drowsy or limp", look: "Does the person look very drowsy, limp, or unable to keep their eyes open?", finding: "very_sleepy" },
  // Nutrition and hydration
  { id: "very_thin", group: "Nutrition", label: "Very thin / wasted", look: "Does the person look severely underweight or wasted?", finding: "very_thin" },
  { id: "hollow_cheeks", group: "Nutrition", label: "Hollow cheeks", look: "Are the cheeks hollow or sunken?", finding: "very_thin" },
  { id: "puffy_face", group: "Nutrition", label: "Puffy, swollen face", look: "Is the face clearly puffy or swollen (moon-shaped), unlike a normal face?", hint: "stomach" },
  { id: "neck_swelling", group: "Nutrition", label: "Swelling at the front of the neck", look: "Is there a visible swelling at the front of the neck (goitre)?" },
  { id: "thin_hair", group: "Nutrition", label: "Thin, pale or reddish hair (child)", look: "If a child is shown, is their hair thin, sparse, pale or reddish?" },
  // Who is in front of the pod
  { id: "child_present", group: "Who is here", label: "A child is present", look: "Is there a child in the pictures?" },
  { id: "infant_held", group: "Who is here", label: "Baby being held", look: "Is someone holding a baby?" },
  { id: "elderly", group: "Who is here", label: "Older adult", look: "Does the main person look over 65 years old?" },
  { id: "pregnant_belly", group: "Who is here", label: "Visibly pregnant", look: "Does the person look visibly pregnant?", finding: "pregnant" },
  { id: "walking_aid", group: "Who is here", label: "Using a cane or crutch", look: "Is the person using a cane, crutch or walker?", hint: "pain" },
  { id: "bandage", group: "Who is here", label: "Already bandaged", look: "Is there a bandage or dressing on the body?", finding: "injury" },
  { id: "mask", group: "Who is here", label: "Wearing a face mask", look: "Is the person wearing a face mask?", hint: "breathing" },
];

export type TraitScan = Record<string, number>; // trait id -> probability seen

// How the pod mentions a hunch before asking about it ("I notice you look tired. ...").
export const NOTICED: Record<string, { en: string; es: string }> = {
  face_droop: { en: "I notice one side of your face looks a little different.", es: "Noto que un lado de su cara se ve un poco diferente." },
  sweaty: { en: "I notice you are sweating.", es: "Noto que está sudando." },
  pale: { en: "You look a bit pale.", es: "Le noto un poco pálido." },
  flushed: { en: "Your face looks a little red.", es: "Le noto la cara un poco roja." },
  red_eyes: { en: "Your eyes look a little red.", es: "Le noto los ojos un poco rojos." },
  yellow_eyes: { en: "Your eyes look a little yellow.", es: "Le noto los ojos un poco amarillos." },
  tearful: { en: "You seem upset, and that's okay.", es: "Le noto afligido, y está bien." },
  sad: { en: "You seem a little down.", es: "Le noto un poco decaído." },
  anxious: { en: "You seem a little worried.", es: "Le noto un poco preocupado." },
  exhausted: { en: "You look tired.", es: "Le noto cansado." },
  drowsy: { en: "You look very sleepy.", es: "Le noto con mucho sueño." },
  coughing: { en: "I heard you cough.", es: "Le escuché toser." },
  mouth_breathing: { en: "I notice you are breathing through your mouth.", es: "Noto que respira por la boca." },
  labored: { en: "It looks a little hard for you to breathe.", es: "Parece que le cuesta un poco respirar." },
  holding_chest: { en: "I see you holding your chest.", es: "Veo que se toca el pecho." },
  holding_head: { en: "I see you holding your head.", es: "Veo que se toca la cabeza." },
  holding_belly: { en: "I see you holding your belly.", es: "Veo que se toca la panza." },
  holding_back: { en: "I see you holding your back.", es: "Veo que se toca la espalda." },
  grimace: { en: "It looks like something hurts.", es: "Parece que algo le duele." },
  tremor: { en: "I notice you are shaking a little.", es: "Noto que está temblando un poco." },
  wound: { en: "I see a wound.", es: "Veo una herida." },
  rash: { en: "I see some spots on your skin.", es: "Veo unas manchas en su piel." },
  bite_marks: { en: "I see some bite marks on your skin.", es: "Veo unas picaduras en su piel." },
};
