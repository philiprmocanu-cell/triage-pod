# Triage Pod — Cal Hacks build plan

A staffed pod at a village health post that **sees, listens and asks** like a triage nurse,
then tells the doctor network what this patient needs — and keeps every post stocked by
moving supplies to where the next patients will be.

## What makes this different from AION (HackDavis)

AION was an SMS / phone-call AI for one person on a $9 flip phone. This project deliberately
shares none of that:

| AION | Triage Pod |
|---|---|
| Patient alone, texting or calling | Patient at a staffed post, health worker + doctor in the loop |
| Text and voice only | **Camera is core**: face droop, heart rate from video, skin colour |
| Gives one person advice | Produces a **triage decision** (green / yellow / red) and resource needs |
| No logistics | **Network-level supply redistribution** across posts + drone delivery |
| SMS fallback, feature phones | No SMS, no feature phones — a camera + mic pod |
| Indian-language education + medical | Demo region chosen to avoid repeating AION (see "Demo region") |

No code, assets or prompts from AION (or Zoron, SipClip, EqualEd, Jev) are reused.

## Feature 1 — the triage nurse step

1. Patient speaks; camera runs continuously.
2. **Word checks** on the live transcript and **camera checks** on the video run in parallel.
3. **Hard danger-sign rules live in code** (`src/lib/triage/rules.ts`), not in the model. If a
   red rule fires, the result is red no matter what the model says.
4. Claude ranks likely causes, then asks the question that would most reduce uncertainty.
5. Stops after 3–6 questions (or immediately on a red rule) and shows:
   - likely causes with estimated probabilities
   - urgency: green (treat here) / yellow (doctor review) / red (emergency)
   - **resources needed, each with a probability** (amoxicillin 80 %, malaria RDT 50 %, oxygen 30 %)
   - doctor required yes/no + one-line reason

Camera checks, all in the browser with MediaPipe Face Landmarker:
- face droop: mouth-corner and eye height asymmetry vs. a short baseline
- heart rate from face video (rPPG: green-channel signal on the cheeks, band-pass 0.7–3 Hz, FFT)
- pallor / jaundice and visible distress: vision model, flagged low-confidence

## Feature 2 — speaks the patient's language and dialect (Cartesia)

- Listen: Cartesia **Ink Whisper** (multilingual, language detected).
- Speak: Cartesia **Sonic-3** (42 languages).
- **Dialect**: Cartesia's base models cannot be retrained in a weekend. What we do instead:
  1. **Clone a consenting native speaker** of the region (e.g. the post's health worker) from a
     ~10 s clip with instant voice cloning. A cloned voice keeps the speaker's accent, so the pod
     speaks in that local dialect. Live demo: record 10 s on stage, the pod switches voices.
  2. **Detect the patient's dialect** from what they say (Claude classifies region from
     transcript wording) and pick the closest voice from a small library of cloned regional voices.
  3. **Adapt vocabulary**: replies use the patient's own words for symptoms.
  - We do **not** clone the patient's own voice (consent, and it would be unsettling).
- Doctor screen shows the original-language transcript next to an English translation.

## Feature 3 — resource redistribution across the network

Each triage outputs resource probabilities. Summed over recent patients they become a demand
forecast per post. The network then moves stock before a post runs out.

1. **Inventory** per post and per hub (amoxicillin, ORS + zinc, malaria RDTs, ACT, rectal
   artesunate, pulse-ox probes, oxygen cylinders).
2. **Forecast** next 48 h demand per post = sum of resource probabilities from the last 48 h,
   scaled by trend. **Outbreak flag** when a symptom cluster (e.g. fever) runs well above that
   post's baseline — pre-position RDTs and ACT around it.
3. **Gap** = stock − forecast − safety buffer. Negative = shortage, positive = surplus.
4. **Transfer plan**: greedy, most-urgent shortage first, fill from the nearest surplus post or
   hub. Respect drone payload (~2–4 lb): oxygen never goes by drone — it goes by road, or the
   patient is routed to the nearest post that has oxygen in stock.
5. **Patient routing**: red low-oxygen patients go to the nearest site with oxygen *and* a free
   bed, not just the nearest clinic.
6. **Dashboard**: map of posts coloured by stock health, arrows for proposed drone flights,
   "Approve all" button. Zipline is simulated (no public API — partnership later).

Demo: a simulated malaria outbreak starts in one district; within a minute the map turns
amber there and the system proposes RDT + ACT flights from surplus posts.

## Demo region

AION went live in Haryana, India, in Indian languages. To keep this clearly separate, the
default demo is **Spanish-speaking Central / South America** (rural Guatemala, Honduras,
Bolivia): Cartesia covers Spanish well and regional Spanish dialects differ strongly, which
shows off dialect matching. Cartesia has no African languages today; Africa stays in the
vision slide. Region is a config value, not hard-coded.

## Weekend schedule (3–4 people)

| When | Voice | Camera | Triage brain | Screens / network |
|---|---|---|---|---|
| Fri night | Cartesia listen + speak (English) | Webcam + face landmarks | Danger rules in code | Pod screen layout |
| Sat AM | Language detect, Spanish voices, voice clone | Face droop | Next-question logic | Result screen |
| Sat PM | Voice ↔ brain | Heart rate from face | Merge word + camera checks | Doctor screen + translation |
| Sat night | **Full loop running end to end** | | | Redistribution engine + map |
| Sun AM | Latency | Lighting tuning | 3 demo stories × 10 runs | Outbreak sim, fake Zipline, slides |
| Sun midday | **Feature freeze — rehearse only** | | | |

## Demo stories

1. Stroke: face droop + slurred sentence → red in under 30 s.
2. Child pneumonia: cough + fever 3 days → follow-ups → yellow, amoxicillin + oxygen check.
3. Malaria outbreak: several fever patients across nearby posts → map turns amber → drone plan.

## Not this weekend

Real Zipline integration, real patient data, medical approval. The pod **supports** the health
worker and doctor; it does not diagnose on its own.
