# The camera: what it sees, what it may say, and the stress test behind it

Written 2026-10-25 after a false alarm: the owner, healthy, sitting at the kiosk with his hand on his
chin, was asked whether one side of his face was drooping. This page says what caused it, what the
camera pipeline does now, and the numbers from the stress test that decided each change.

## 1. What caused the false stroke question

Three things lined up, and none of them was the picture model (Jev) seeing a droop:

1. **The on-device mouth-corner check latched.** `src/lib/camera/faceDroop.ts` measures, from the
   MediaPipe face mesh, how much lower one mouth corner sits than the other. With a hand over the
   mouth and chin the mesh guesses where the hidden corners are; 1.5 s of a guessed asymmetry above
   7 % of the eye distance "flagged" the face, and the flag was **kept for the whole visit**. The
   engine turned that flag straight into a hunch at 80 %.
2. **One burst was enough.** The hunch threshold for face droop was 0.45 on a score smoothed
   `0.5 × previous + 0.5 × now`, so a single Jev reading of 0.9, or two of 0.6, asked the question.
   Face droop was also the one trait asked **without** the "most people here are healthy" lead-in.
3. **The question came before the test.** The pod said "I notice one side of your face looks a little
   different" and asked about weakness first; the smile test (the actual stroke check) came after.

On the owner's own kiosk picture Jev gives face droop **0.14** (and 0.05–0.15 across the five
webcam variations). What Jev does read into a hand on the chin is **"holding the head" (0.56–0.76)**,
which would have led to "I see you holding your head. Do you have a headache?" — a second false
alarm waiting to happen, now handled the same way as the stroke sign.

## 2. The pipeline now

Every 2 s the pod sends a burst (8 pictures over the last 2 s, a face close-up on every third) to
`/api/scan`. That route calls `src/lib/judge/pipeline.ts`, which is also what the stress-test
harness calls, so the test runs the real path.

| step | where | what it does |
|---|---|---|
| Jev scores all 61 traits | `src/lib/judge/scan.ts` | unchanged questions; every trait but face droop carries the "assume healthy" lead-in (face droop keeps the bare wording: see §5) |
| view gates | `scan.ts` `gateByView` | face/eye/skin traits need `face_clear ≥ 0.6`, posture traits need `body_clear ≥ 0.6` (unchanged) |
| lighting check | `src/lib/judge/lighting.ts` | mean brightness of the left vs right half of the face close-up (sharp, 64×64 grey, central band); `asym = |L−R| / brighter` |
| burst memory | `src/lib/judge/evidence.ts` | the last 8 bursts (40 s) per kiosk session, in `globalThis` so `/api/scan`, `/api/judge` and `/api/test` share one notebook |
| high-stakes rule | `evidence.ts` `assess` | the stroke, heart and breathing signs (`HIGH_STAKES`: face droop, slack mouth, gaze to one side, confused look, limp arm, holding the head, holding the chest, laboured breathing, nostril flare, fast chest, mouth breathing, blue lips) must be at or above their hunch threshold on **3 consecutive bursts**; face signs need `face_clear ≥ 0.8` and lighting `asym ≤ 0.30` on each of those bursts; body signs need `body_clear ≥ 0.6` |
| second opinion | `src/lib/judge/opinion.ts` | once the rule is met, Claude (`claude-opus-5-5`, effort low) looks at 3 whole pictures + 2 close-ups of the same burst with a strict rubric; **no / unclear → the score is zeroed, nothing is asked**, the disagreement goes to `data/judge-log.jsonl`. Verdicts hold 90 s. Live wait ≤ 3 s. |
| face droop is different | `evidence.ts` `SMILE_CONFIRMS` | no Claude on the resting face (see §5). The persisted score goes to the engine, which runs the **smile test first**, framed as a routine check ("Let's do a quick check together. Please give me a big smile…"), never mentioning the face |
| smile test | `src/app/api/test/route.ts` | Jev judges the test pictures as before; if it calls the smile uneven (≥ 0.6), Claude judges the same test pictures with a smile-specific rubric; no / unclear → demoted to 0.3, no question |
| the question | `src/lib/triage/engine.ts` hunch block | only an uneven smile (Jev + Claude, or the on-device smile measure) earns "I notice one side of your face looks a little different. Is one side of your face or one arm weak or numb?" An even smile drops the hunch silently |
| on-device flag | engine hunch block | the MediaPipe flag now only speaks when there is **no live Jev scan**, and even then it leads to the smile test, never to a question |
| seen evidence | engine hunch block | face droop no longer counts as "seen" evidence of weakness by itself; only the smile test can |
| operator line | `src/components/CameraPanel.tsx` + `GET /api/scan` | on `/pod` (never on `/kiosk`) the camera panel shows, every 2 s, lines like `face droop 0.52 × 1 burst — not asked (needs 3)`, `holding the chest 0.96 × 3 bursts — Claude agrees (both hands pressed to the chest) → will ask`, `… — not asked: uneven light (left side 48% brighter)`, and the smile test's verdict |

When Claude cannot answer at all (no key, key at its monthly cap, API down, or no answer within 3 s
on two bursts in a row) that is treated as *no second opinion*, not as "no": the sign is asked on
persistence alone, but only if it was **strong** (at the old single-burst bar, threshold / 0.875,
on every one of the 3 bursts), and the operator line says so ("Claude Anthropic key at its usage
limit: asked on persistence alone"). A heart attack must not go unasked because a spend cap was hit.

## 3. The stress test

Harness: `/api/judge` (`src/app/api/judge/route.ts`) runs one burst through the real pipeline under
a named session and reports Jev's raw answers, the view-gated scores, what the old pod would have
asked (`oldPolicy`), what the new pod passes to the engine (`traits`), the evidence lines and,
optionally, Claude's verdict on every trait Jev leaned towards (≥ 0.3) plus the traits the photo
is known to show. Scripts (scratchpad, `…/scratchpad/judge/`): `make_variants.py` (Pillow: the
owner's kiosk picture and three healthy portraits × dim 45 %, one-sided light 100 → 35 %, head
tilt ±10°, quarter resolution, JPEG q18 + speckle), `harness3.py` (3 identical bursts per picture,
pod-style: 8 frames, close-up on frames 0/3/6), `report.py` (the tables below).

Pictures: the 16 test photos (healthy neutral ×2, smiling, Bell's palsy ×2, jaundice ×2, pallor,
measles ×2, sweat, mask, chest-holding, kwashiorkor, side-on, far away) plus 28 healthy webcam
variants (4 healthy bases × 7 conditions, the original included). 44 pictures, 132 bursts.

Two runs were needed. Run 1 (2026-10-25 01:00) used a stricter face-droop wording and had Claude
judge every flagged trait; that run **spent the project's Anthropic key to its monthly cap**
("You have reached your specified API usage limits. You will regain access on 2026-11-01"), which
also stops the translations, phrasing and handover notes in `brain.ts` until 1 November. Run 3
(the final numbers, 01:40) is Jev-only with the shipped wording; Claude's verdicts in the tables
come from run 1 on the same pictures.

### 3a. Photo × trait

Jev before = the burst-1 score under the old wording (run 1 for face droop, otherwise identical);
Jev after = burst-3 score, shipped wording. "old pod" = would the old policy have asked;
"new pod" = does the new pipeline pass the sign to the engine (for face droop that means: to the
smile test, not to a question).

| photo | trait | Jev before (old wording) | Jev after | old pod | new pod | Claude | Jev vs Claude | why |
|---|---|---|---|---|---|---|---|---|
| 02_neutral_scott | eyelid_droop | 0.33 | 0.30 | no | no | – |  |  |
| 03_smile | elderly | 0.53 | 0.55 | no | no | no | agree | she looks middle-aged, with mostly dark hair and few deep wrinkles, not cl |
| 03_smile | gaze_off | 0.31 | 0.32 | no | no | no | agree | she is smiling and glancing to one side as if at someone off-camera; nothing shows her eyes are stuck there. |
| 04_palsy_teeth | agitated | 0.46 | 0.47 | no | no | yes | DISAGREE | a clear angry, snarling expression with a furrowed brow and raised upper lip in every picture |
| 04_palsy_teeth | anxious | 0.68 | 0.71 | no | ASKED | no | DISAGREE | the wide eyes go with an angry or disgusted face, not a frightened one |
| 04_palsy_teeth | blisters | 0.38 | 0.36 | no | no | no | agree | no blisters or sores visible |
| 04_palsy_teeth | confused_look | 0.33 | 0.37 | no | no | no | agree | a deliberate, focused expression, not a confused or disoriented one |
| 04_palsy_teeth | eyelid_droop | 0.52 | 0.56 | no | no | no | agree | the slight narrowing of one eye comes from the sneer scrunching the face; both lids are open |
| 04_palsy_teeth | face_droop | 0.58 | 0.59 | ASKED | ASKED | no | DISAGREE | the uneven mouth is an active one-sided sneer (lip pulled up), not a drooping side |
| 04_palsy_teeth | gaze_off | 0.45 | 0.49 | no | no | no | agree | eyes look straight at the camera |
| 04_palsy_teeth | grimace | 0.55 | 0.57 | no | no | no | agree | the expression is a sneer or snarl and does not look like pain |
| 04_palsy_teeth | mouth_breathing | 0.42 | 0.44 | no | no | no | agree | the mouth is open only as part of a held snarl, not for breathing |
| 04_palsy_teeth | mouth_sores | 0.32 | 0.34 | no | no | no | agree | mouth corners look normal |
| 04_palsy_teeth | pale | 0.37 | 0.34 | no | no | no | agree | lips and skin show normal color |
| 04_palsy_teeth | slack_mouth | 0.50 | 0.50 | no | no | no | agree | the mouth is pulled into a tense snarl, not hanging slack, with no drool |
| 04_palsy_teeth | wound | 0.29 | 0.28 | no | no | no | agree | no cut or open wound visible |
| 05_palsy_neuro | agitated | 0.41 | 0.41 | no | no | unclear | agree | no readable answer |
| 05_palsy_neuro | anxious | 0.68 | 0.68 | no | no | unclear | DISAGREE | no readable answer |
| 05_palsy_neuro | face_droop | 0.18 | 0.18 | no | no | no | agree | the lopsided mouth looks like a deliberate pulled face, and both brows and eyes are raised evenly |
| 05_palsy_neuro | mouth_breathing | 0.51 | 0.46 | no | no | no | agree | the open mouth is part of a held facial exp |
| 05_palsy_neuro | pale | 0.38 | 0.37 | no | no | no | agree | the lips and skin show a normal pink tone |
| 05_palsy_neuro | slack_mouth | 0.62 | 0.64 | no | no | no | DISAGREE | the lips are held tense in a grimace showing the teeth, not hanging slack, and there is no drooling |
| 06_jaundice_cdc | yellow_eyes | 0.92 | 0.92 | ASKED | ASKED | yes | agree | whites of both eyes are clearly and evenly yellow in every frame and close-up. |
| 06_jaundice_cdc | yellow_skin | 0.67 | 0.67 | no | no | unclear | DISAGREE | skin is dark with warm lighting, so a yellow tint cannot be clearly judged. |
| 07_jaundice_icterus | gaze_off | 0.26 | 0.29 | no | no | no | agree | eyes look toward the camera, not fixed hard to one side |
| 07_jaundice_icterus | yellow_eyes | 0.86 | 0.89 | ASKED | ASKED | yes | agree | the whites of both eyes are strikingly yellow in every picture |
| 07_jaundice_icterus | yellow_skin | 0.66 | 0.72 | no | ASKED | unclear | DISAGREE | skin looks yellowish-tan, but warm lighting and natural skin tone could explain it |
| 08_pallor_tones | child_present | 0.88 | 0.87 | no | no | – |  |  |
| 08_pallor_tones | pale | 0.49 | 0.51 | no | no | unclear | agree | the camera shows an illustrated medical chart of pallor examples, not a real person's face, so the sitter |
| 08_pallor_tones | thin_hair | 0.58 | 0.57 | no | no | – |  |  |
| 09_measles_baby | bite_marks | 0.30 | 0.29 | no | no | no | agree | The spots are a widespread fine rash, not scattered insect-bite bumps. |
| 09_measles_baby | child_present | 0.97 | 0.96 | ASKED | ASKED | yes | agree | An infant is clearly shown. |
| 09_measles_baby | drowsy | 0.35 | 0.38 | no | no | unclear | agree | Eyelids are heavy and half-closed, but this cannot be told apart from ordinary sleepiness. |
| 09_measles_baby | exhausted | 0.38 | 0.43 | no | no | unclear | agree | Eyes are half-closed, but a resting or sleepy baby looks like this. |
| 09_measles_baby | eyelid_droop | 0.53 | 0.53 | no | no | unclear | agree | The eyes look uneven, but the head is turned and tilted, so it may be the angle. |
| 09_measles_baby | infant_held | 0.48 | 0.48 | no | no | unclear | agree | The baby lies on a blanket and only part of an adult arm is visible, not clearly holding. |
| 09_measles_baby | mouth_breathing | 0.65 | 0.68 | no | no | unclear | DISAGREE | Lips are slightly parted, but still pictures cannot show breathing. |
| 09_measles_baby | pale | 0.37 | 0.31 | no | no | no | agree | Lips are pink and skin color is normal. |
| 09_measles_baby | rash | 0.87 | 0.87 | ASKED | ASKED | yes | agree | Many small red spots cover the face, forehead and neck. |
| 09_measles_baby | slack_mouth | 0.73 | 0.79 | ASKED | no | no | DISAGREE | Lips are only slightly parted, with no hanging jaw or drool. |
| 09_measles_baby | slumped | 0.52 | 0.50 | no | no | no | agree | This is an infant lying down, which is normal for a baby. |
| 09_measles_baby | thin_hair | 0.36 | 0.30 | no | no | no | agree | Hair is dark and reasonably full. |
| 10_measles_phil | blisters | 0.30 | 0.32 | no | no | – |  |  |
| 10_measles_phil | burn | 0.28 | 0.30 | no | no | – |  |  |
| 10_measles_phil | child_present | 0.94 | 0.93 | ASKED | ASKED | unclear | DISAGREE | no readable answer |
| 10_measles_phil | infant_held | 0.76 | 0.75 | ASKED | ASKED | unclear | DISAGREE | no readable answer |
| 10_measles_phil | rash | 0.97 | 0.97 | no | no | yes | agree | widespread red spots are clearly visible over the back, buttocks, arms and legs |
| 11_sweat | anxious | 0.34 | 0.35 | no | no | – |  |  |
| 11_sweat | dry_lips | 0.37 | 0.36 | no | no | – |  |  |
| 11_sweat | elderly | 0.45 | 0.41 | no | no | no | agree | looks middle-aged, not clearly over 65 |
| 11_sweat | exhausted | 0.38 | 0.36 | no | no | – |  |  |
| 11_sweat | face_droop | 0.37 | 0.39 | no | no | – |  |  |
| 11_sweat | grimace | 0.47 | 0.48 | no | no | no | agree | he is wiping his face with a towel; expression is ordinary squinting, not clear pain |
| 11_sweat | holding_head | 0.36 | 0.35 | no | no | no | agree | hand is holding a towel to the face while wiping, not clutching the head |
| 11_sweat | hollow_cheeks | 0.73 | 0.73 | no | no | – |  |  |
| 11_sweat | mouth_sores | 0.31 | 0.33 | no | no | – |  |  |
| 11_sweat | pale | 0.49 | 0.51 | no | no | – |  |  |
| 11_sweat | puffy_eyes | 0.42 | 0.40 | no | no | – |  |  |
| 11_sweat | red_eyes | 0.32 | 0.33 | no | no | – |  |  |
| 11_sweat | sad | 0.79 | 0.78 | no | no | – |  |  |
| 11_sweat | sneezing | 0.56 | 0.57 | no | no | – |  |  |
| 11_sweat | sunken_eyes | 0.59 | 0.58 | no | no | – |  |  |
| 11_sweat | sweaty | 0.32 | 0.32 | no | no | no | agree | face mostly hidden by towel, no visible beads or drips of sweat |
| 11_sweat | tearful | 0.51 | 0.55 | no | no | – |  |  |
| 11_sweat | very_thin | 0.64 | 0.63 | no | no | – |  |  |
| 12_mask | elderly | 0.58 | 0.57 | no | no | no | agree | appears middle-aged, not clearly over 65 |
| 12_mask | holding_head | 0.75 | 0.70 | ASKED | ASKED (with Claude: no) | no | DISAGREE | chin resting on a fist and glasses held near the brow, an ordinary pose rather than clutching the head |
| 12_mask | mask | 0.95 | 0.96 | ASKED | ASKED | yes | agree | a surgical face mask is clearly covering her nose and mouth in all frames |
| 13_chest | anxious | 0.37 | 0.33 | no | no | – |  |  |
| 13_chest | elderly | 0.29 | 0.31 | no | no | unclear | agree | the face is not visible in any picture, so age cannot be judged |
| 13_chest | holding_chest | 0.97 | 0.97 | ASKED | ASKED | yes | agree | both hands are clearly pressed against the chest in every frame |
| 14_kwash | blisters | 0.57 | 0.52 | no | no | unclear | agree | brownish crusted material around the lips and cheek could be sores or food residue. |
| 14_kwash | child_present | 0.98 | 0.97 | ASKED | no | yes | agree | a young child is clearly shown. |
| 14_kwash | face_droop | 0.32 | 0.35 | no | no | – |  | one side of face drooping 0.35 × 0 bursts — not asked (needs 3) |
| 14_kwash | flat | 0.44 | 0.43 | no | no | unclear | agree | the face looks blank, but the frames are identical, so lack of movement cannot be judged. |
| 14_kwash | mouth_sores | 0.38 | 0.39 | no | no | unclear | agree | crusting at the mouth corners cannot be told apart from food residue. |
| 14_kwash | puffy_eyes | 0.43 | 0.45 | no | no | unclear | agree | the eyelids may be slightly full, but they are not clearly swollen. |
| 14_kwash | puffy_face | 0.94 | 0.93 | ASKED | ASKED | yes | agree | the face is markedly round and swollen, especially the cheeks, with a moon-shaped look. |
| 14_kwash | rash | 0.29 | 0.29 | no | no | no | agree | there is only a small reddish mark on one cheek, not a rash or many spots. |
| 14_kwash | slack_mouth | 0.49 | 0.54 | no | no | yes | DISAGREE | lips are parted with the mouth hanging slightly open and the lips look wet in every frame. |
| 14_kwash | sneezing | 0.50 | 0.48 | no | no | unclear | agree | there is a faint shine under the nose but no clear discharge or sneezing. |
| 14_kwash | sweaty | 0.31 | 0.30 | no | no | – |  |  |
| 14_kwash | thin_hair | 0.53 | 0.53 | no | no | yes | DISAGREE | the child's hair is sparse, wispy and reddish. |
| 15_side | gaze_off | 0.29 | 0.30 | no | no | – |  |  |
| 16_far | child_present | 0.96 | 0.96 | ASKED | ASKED | yes | agree | two young children are clearly standing in front of the tree |
| 16_far | flat | 0.35 | 0.32 | no | no | – |  |  |
| 16_far | holding_back | 0.42 | 0.36 | no | no | no | agree | neither child is clearly holding their lower back; one arm just hangs partly behind the body |
| 16_far | hollow_cheeks | 0.44 | 0.45 | no | no | – |  |  |
| 16_far | pale | 0.34 | 0.30 | no | no | – |  |  |
| 16_far | pregnant_belly | 0.68 | 0.67 | no | no | no | DISAGREE | these are small children; a rounded belly is not a sign of pregnancy |
| 16_far | puffy_face | 0.42 | 0.40 | no | no | – |  |  |
| 16_far | sunken_eyes | 0.34 | 0.31 | no | no | – |  |  |
| 16_far | very_thin | 0.58 | 0.64 | no | no | – |  |  |
| 02_neutral_scott__orig | eyelid_droop | 0.31 | 0.34 | no | no | no | agree | both eyelids look about level; the slight narrowing on both sides fits his smile and slight head tilt, not a droop. |
| 02_neutral_scott__tilt_plus10 | eyelid_droop | 0.52 | 0.52 | no | no | no | agree | both eyelids look symmetric in a relaxed smiling squint; the apparent height difference comes from the head tilt. |
| 03_smile__dim | elderly | 0.68 | 0.68 | no | no | no | DISAGREE | she appears middle-aged, with smooth skin and dark hair, not clearly over 65. |
| 03_smile__dim | gaze_off | 0.32 | 0.31 | no | no | no | agree | she is smiling and casually glancing to the side; nothing shows her eyes are stuck there. |
| 03_smile__jpegnoise | elderly | 0.64 | 0.63 | no | no | no | DISAGREE | appears to be a middle-aged adult, not clearly over 65 |
| 03_smile__jpegnoise | gaze_off | 0.36 | 0.38 | no | no | – |  | eyes looking to one side 0.38 × 0 bursts — not asked (needs 3) |
| 03_smile__jpegnoise | sweaty | 0.58 | 0.60 | no | no | no | DISAGREE | skin shows ordinary shine with no visible beads or drips of sweat |
| 03_smile__lowres | elderly | 0.55 | 0.55 | no | no | no | agree | smooth skin and dark hair suggest a middle-aged adult, not someone over 65 |
| 03_smile__lowres | gaze_off | 0.35 | 0.31 | no | no | no | agree | she is smiling with her head turned the same way, which looks like an ordinary sideways glance rather than eyes locked to one side |
| 03_smile__orig | elderly | 0.56 | 0.55 | no | no | no | agree | she looks middle-aged, with mostly dark hair and fairly smooth skin, not clearly over 65. |
| 03_smile__orig | gaze_off | 0.34 | 0.35 | no | no | no | agree | she is smiling and glancing to one side with her head turned the same way; nothing shows the eyes are stuck. |
| 03_smile__sidelight | elderly | 0.61 | 0.61 | no | no | unclear | DISAGREE | no readable answer |
| 03_smile__sidelight | gaze_off | 0.34 | 0.33 | no | no | unclear | agree | no readable answer |
| 03_smile__tilt_minus10 | elderly | 0.61 | 0.63 | no | no | no | DISAGREE | she looks middle- |
| 03_smile__tilt_minus10 | gaze_off | 0.41 | 0.37 | no | no | no | agree | an ordinary sideways glance with the head turned the same way while smiling; nothing suggests the eyes are stuck |
| 03_smile__tilt_plus10 | elderly | 0.51 | 0.54 | no | no | no | agree | appears middle-aged, with no clear signs of being over 65 |
| 03_smile__tilt_plus10 | gaze_off | 0.51 | 0.52 | no | no | no | agree | eyes glance to one side while smiling, which looks like an ordinary sideways look; nothing shows they cannot move |
| owner_kiosk__dim | holding_head | 0.60 | 0.62 | no | no | no | DISAGREE | a hand resting on the chin and mouth in a relaxed thinking pose, not holding the head |
| owner_kiosk__jpegnoise | holding_head | 0.63 | 0.66 | no | no | no | DISAGREE | the hand rests casually under the chin and over the mouth in a relaxed pose, not clutching the head. |
| owner_kiosk__lowres | holding_head | 0.65 | 0.67 | no | no | no | DISAGREE | the hand rests under the chin and over the mouth in an ordinary thinking pose, not clutching the head. |
| owner_kiosk__orig | holding_head | 0.64 | 0.67 | no | no | no | DISAGREE | hand resting on chin and mouth in a relaxed thinking pose, not clutching the head |
| owner_kiosk__sidelight | holding_head | 0.58 | 0.55 | no | no | no | agree | hand rests on chin/mouth in an ordinary thinking pose; not clutching or holding the head. |
| owner_kiosk__tilt_minus10 | holding_head | 0.59 | 0.62 | no | no | no | DISAGREE | hand resting on the chin and mouth in an ordinary thinking pose, not clutching the head |
| owner_kiosk__tilt_plus10 | holding_head | 0.72 | 0.72 | ASKED | ASKED (with Claude: no) | no | DISAGREE | hand resting on chin/mouth in an ordinary thinking pose, not holding the head |

### 3b. False-alarm rate on the healthy pictures

False-alarm rate on the 33 healthy pictures (the 5 healthy/unjudgeable photos of the 16-photo set + 28 webcam variants). A trait counts as a false alarm when the pod would have asked about it.

| trait | before: asked on healthy | after, Claude unavailable (today, key capped) | after, with Claude | Claude judged / said no or unclear |
|---|---|---|---|---|
| child_present | 1/33 (3%) | 1/33 (3%) | 1/33 (3%) | 1 / 0 |
| holding_head | 1/33 (3%) | 1/33 (3%) | 0/33 (0%) | 7 / 7 |
| elderly | 0/33 (0%) | 0/33 (0%) | 0/33 (0%) | 8 / 8 |
| eyelid_droop | 0/33 (0%) | 0/33 (0%) | 0/33 (0%) | 2 / 2 |
| gaze_off | 0/33 (0%) | 0/33 (0%) | 0/33 (0%) | 7 / 7 |
| holding_back | 0/33 (0%) | 0/33 (0%) | 0/33 (0%) | 1 / 1 |
| pregnant_belly | 0/33 (0%) | 0/33 (0%) | 0/33 (0%) | 1 / 1 |
| sweaty | 0/33 (0%) | 0/33 (0%) | 0/33 (0%) | 1 / 1 |
| **all traits** | **2 alarms** | **2 alarms** | **1 alarms** | |

### 3c. True positives

| picture | sign | Jev | old pod | new pod | Claude (run 1) |
|---|---|---|---|---|---|
| 13_chest (hands pressed to chest) | holding_chest | 0.96–0.97 on all 3 bursts | asked | passes after burst 3; live second opinion in run 1: **yes**, 2.5 s ("both hands clearly pressed against the centre of the chest in every frame") → asked | yes |
| 04_palsy_teeth (Bell's palsy, showing teeth) | face_droop | 0.58–0.60 (bare wording); 0.41–0.43 with the strict wording | asked straight away | passes after 3 bursts → smile test. On this *still* photo Jev's smile test says "not attempted" (no movement), so no question; on a live patient the smile test is the real check | **no** ("an active one-sided sneer, not a drooping side") |
| 05_palsy_neuro (Bell's palsy, neurology textbook) | face_droop | 0.09–0.17: Jev misses it, before and after | not asked | not asked (slack_mouth 0.62–0.66 persisted; Claude said no) | no ("a deliberate pulled face") |
| 06/07 jaundice | yellow_eyes | 0.88–0.94 | asked | asked (not high-stakes: unchanged path) | yes |
| 09/10 measles | rash | 0.86–0.97 | asked | asked | yes |
| 12 mask | mask | 0.97 | noted | noted | yes |
| 14 kwashiorkor | puffy_face, child | 0.93 / 0.97 | asked | asked | yes / yes |
| 11 sweat, 08 pallor | sweaty, pale | 0.0 / 0.48 (face not clear: 0.11 / 0.25) | not asked | not asked | no / unclear |

### 3d. Latency

Final run (Jev only, 132 bursts, 8 pictures + 3 close-ups each, over the hackathon Wi-Fi):

| stage | p50 | p90 | max |
|---|---|---|---|
| Jev scan of a burst (`/api/scan` before the change, same 8-frame burst) | 717 ms | 1603 ms | 3759 ms |
| whole pipeline per burst without a second opinion (lighting check is ~5 ms, runs in parallel with Jev) | 717 ms | 1603 ms | 3759 ms |
| Claude second opinion, 1 trait, live path (run 1, chest) | 1.8–2.5 s | | |
| Claude "judge everything" (harness only, 2–13 traits) | 4.1 s | 7.9 s | 9.2 s |

The task's "≤ ~400 ms per burst" was never true of the 8-frame burst the pod already sent (the
old `photo_runner` figure of ~465 ms was for 3 frames with no close-ups); nothing in this change
adds to the Jev time. The second opinion is paid only when a high-stakes sign has persisted for
three bursts, once per sign per 90 s, and is capped at 3 s.

## 4. Thresholds and rules, with the data that set them

| rule | value | why |
|---|---|---|
| bursts a high-stakes sign must persist | 3 (≈ 6 s) | the owner's alarm came from one latched measurement; three identical bursts on a still photo still pass, so this guards against flicker, not against a steady wrong reading (that is what the second opinion and the smile test are for) |
| `face_clear` on those bursts | ≥ 0.8 | the healthy portraits score 0.90–0.99; the side-on (0.03), far (0.16), masked (0.11) and sweat (0.11) photos sit far below; 0.8 leaves room for a dim webcam (owner dim variant: 0.87, lowres: 0.81) |
| lighting asymmetry | ≤ 0.30 | even-lit faces: 0.03–0.26 (owner 0.19, Kyle 0.20, Scott 0.15); the one-sided-light variants: Kyle 0.48, Scott 0.21 (his face is lit from the other side), the outdoor smiling portrait 0.54 natural. 0.30 blocks the strong cases without blocking ordinary indoor light. The owner's own picture is at 0.19 (right side brighter) |
| hunch thresholds | face droop 0.45, others 0.60, **unchanged** | the healthy set produced **no** face-droop alarm at either wording, so raising the bar would only cost the palsy photo (0.58–0.60) |
| face-droop wording | bare (no "assume healthy" lead-in), **unchanged** | the stricter wording tried in run 1 drops the palsy photo from 0.59 to 0.43 (under 0.45) and buys nothing on the healthy set. `STRICT_DROOP_EXTRA` is kept in `scan.ts` as an experiment flag |
| holding_head added to high-stakes | — | the owner's hand-on-chin reads as "holding the head" 0.56–0.76 (would ask "do you have a headache?"); Claude says no on 7/7 variants |
| persistence-only bar (Claude unavailable) | threshold / 0.875 on every burst (0.69; 0.51 for droop) | the old single-burst bar; keeps the owner's holding_head variants (0.56–0.67) from asking when no second opinion can be had, while the chest photo (0.96) still asks |
| second-opinion wait | 3 s live, 6 s after the smile test | measured: 1-trait calls 1.8–2.5 s; multi-trait "judge everything" calls 2.6–9.2 s (median 4.1 s) |

## 5. What the stress test says about Claude as the judge

- On every **healthy** picture where Jev leaned towards a sign, Claude said no or unclear (holding
  the head 7/7, eyes to one side 7/7, older adult 8/8, drooping eyelid 2/2, sweaty 1/1, pregnant
  1/1). Jev vs Claude disagreements are all in the direction of Jev over-calling.
- On the **true** signs Claude agreed: chest 1/1, yellow eyes 2/2, rash 2/2, mask, puffy face, child.
- On the two **Bell's palsy** photos Claude said **no** every time, at low and medium effort, with a
  strict and a clinical rubric ("deliberate grimace / sneer; brows and eyes raise evenly"). That is
  why Claude does not judge the *resting* face for droop: it would have blocked the one palsy photo
  Jev catches. Instead the smile test runs (cheap, 5 s, framed as routine) and Claude judges the
  smile pictures, where real weakness shows as one side not moving.

## 6. What remains

- **The Anthropic key is at its monthly cap until 2026-11-01.** Until then the second opinion is
  off (the pod says so on the operator line and asks the strong, persisted signs on persistence
  alone) and so are translations, nurse-style phrasing and handover notes (`brain.ts`). Raise the
  cap in the Anthropic console or use another key.
- Still photos cannot exercise the smile test (no movement), so "new pod asks the stroke question"
  could not be verified end to end on the palsy photos; it needs a live patient or a short video.
- Jev misses the textbook palsy photo (0.09–0.17) with every wording; the on-device smile measure
  and the smile test are the real stroke check, as before.
- In `next dev`, editing any server file recompiles the route and **empties the burst memory**
  (streaks restart at 1). Harmless on the kiosk; confusing in a test.
- The owner's false alarm was reproduced by reasoning from the code and the owner's last scan
  (`data/last-scan.json`: face droop 0.14, holding head 0.58), not by replaying the live session;
  `data/judge-log.jsonl` now records every second-opinion decision so the next one can be.
- The test photos are stock pictures; a set of real kiosk sessions (10 s clips) would make this
  table worth far more.

## 7. Re-running

```
# dev server on :3417; from the scratchpad judge folder
python3 make_variants.py            # healthy webcam variants (Pillow)
python3 harness3.py                 # 3 bursts per picture through /api/judge
python3 report.py > report.md       # the tables in this file
node opinion_test.mjs low strict p04.jpg:face_droop   # one picture straight at Claude
```
