# Triage Pod — how the software is built, every question it can ask, and what happens in each case

Generated from the code on 2026-10-24 (`src/lib/triage/*.ts`). The scenario transcripts at the end come from simulated spoken patients run through the real system (voice in, voice out).


## 1. The shape of it

```
 PATIENT  --speaks-->  laptop mic --> Cartesia STT (es + en) ----+
   ^                                                            |
   | hears                                                      v
 Cartesia TTS <-- words (Claude) <-- DECISIONS (Jev) <-- TRIAGE ENGINE <-- camera scan (Jev, 61 traits)
   (regional voice)                  next question,         |               face droop + pulse (on-device)
                                     conditions, orders     |               finger sensor (pod, Wi-Fi)
                                                            v
                              registry (data/registry.json) + SpacetimeDB "podnet"
                                                            |
            +-----------------------------------------------+------------------------------+
            v                                               v                              v
     /globe (3D map, drones)                 /government (stock x posts, agents)    /patients (vaccines due)
```

Three AI services, each with one job:
- **Jev** (TypeSafe) answers every yes/no and multiple-choice question the engine puts to it: "did the patient say they have a fever?", "which condition is most likely in this area?", "is the face sweaty in these pictures?". Fast (0.3-1 s), calibrated probabilities.
- **Claude** only words things: restates the complaint, rephrases the next question like a nurse who listened, answers the patient's own questions (max 25 words), writes the closing advice, the doctor's handover and the government briefing. It never decides urgency.
- **Cartesia** turns speech into text (both languages at once; Jev picks the real one) and text into a regional voice.

Rules in code override everything (red flags). A condition is named only when a rule fired or the evidence is strong (>= 70% after enough questions, with >= 2 separate findings). Nothing is ordered for a guess.

## 2. The screens

| Screen | Who | Shows |
|---|---|---|
| `/kiosk?village=Katete&pod=triagepod.local` | the patient | the question in big type, both languages, "come closer" if the camera cannot judge; no diagnoses |
| `/pod?village=Katete` | the operator | the same visit plus camera panels, a typed-answer box, region and accent settings, the result panel |
| `/staff` | the health worker | live mirror: conversation, decision path, confident conditions, the exact order, vitals entry (SpO2, temp, BP, glucose) |
| `/globe` | judges | 3D satellite map: +1 bubbles per need, drones/trucks at real speed with ETA, live feed |
| `/government` | provincial office | every post x every item, used / on the way, agent decisions log, Claude briefing |
| `/patients` | posts | 24 profiles, vaccine doses due on Zambia's schedule, send to home |
| `/agents`, `/dashboard`, `/deploy`, `/registry`, `/demo` | judges / you | agent bus, supply simulator, where-next with World Bank data, saved visits, the demo script |

## 3. One visit, step by step

1. **Look.** The camera scans every 3.5 s: Jev judges 61 traits over the last three pictures (plus a face close-up). Face, skin and eye traits are judged only when a face is close, facing and lit; posture traits (holding chest, cane, bandage) only need the body in view. A patient's clear "no" later beats the camera.
2. **Intake.** Name, village, who the visit is for and age, consent to save. Skipped if already said ("I'm Rosa from Katete with my son, he's three").
3. **Open.** "What brings you in today?" Then Claude restates it: "I understand you've had fever with chills for three days, is that right?" A garbled transcript gets "tell me again in other words".
4. **History.** Since when, what it stops you doing, how strong 1-10. Skipped for "just a check-up, I feel fine".
5. **Camera hunches** (at most two signs, two questions each): confirm the sign in the patient's words, then its cause (section 6).
6. **Pathway questions.** The complaint opens one or more pathways (section 5); danger signs first; physical tests where a camera can judge (smile, arm drift, walk, crouch, bend, chest, palms, feet, finger sensor).
7. **"Anything else?"** then the **closing**: urgency colour, what the health worker will do, Claude's safety-net advice ("come back right away if...").
8. **Save.** Registry + handover note + the exact order to SpacetimeDB, which feeds the globe, the government view and the agents.

A red flag at any point: "We are calling for help now", up to three more danger-sign questions (fits, bleeding, can they drink), then the red closing. A suspected stroke runs the smile, arm and speech checks first. Suicide risk closes warmly at once.

If the patient asks the pod something ("is this serious?"), it answers in one or two sentences and then asks the side-stepped question again. If they say "sorry, what?", it repeats once in the language they are speaking.

## 4. Every question the pod can ask

### Intake, opening, history

- **intake:name** - Hello, I'm the health pod. What's your name?
- **intake:community** - Where do you live?
- **intake:who** - Is this visit for you or for someone else, like a child? How old are they?
- **open** - Thank you. What brings you in today? Tell me what is bothering you the most.
- **history:confirm** - Let me check I understood you correctly. Is that right?
- **history:onset** - Since when have you felt like this?
- **history:impact** - How is this affecting your day? Is there anything you can't do because of it?
- **history:severity** - From 1 to 10, how strong is it right now?
- **history:else** - Is there anything else that worries you, or anything else you feel?

### Findings (53 yes/no symptoms; each has Spanish wording, some a child version)

| key | label | the question |
|---|---|---|
| `chest_pain` | Chest pain or pressure | Do you have pain or pressure in your chest? |
| `pain_spreads` | Pain spreads to arm, jaw or back | Does the pain move to your arm, jaw or back? |
| `sweating` | Sweating or clammy | Are you sweating a lot right now, or breaking into a cold sweat, even without heat or hard work? |
| `short_of_breath` | Short of breath | Is it hard to breathe right now? |
| `sudden_onset` | Started suddenly | Did this start suddenly, within the last few hours? |
| `face_or_arm_weakness` | Face or arm weakness | Is one side of your face or one arm weak or numb? |
| `confused_speech` | Slurred or confused speech | Please repeat after me: \ |
| `headache` | Headache | Do you have a headache? |
| `worst_headache` | Sudden, worst-ever headache | Did the headache start suddenly, like a blow, and is it the worst you have ever had? |
| `light_hurts` | Light or noise hurts | Does light or noise make it worse? |
| `severe_headache` | Severe headache or blurred vision | Do you have a very strong headache or blurry vision? |
| `seizure` | Seizure / convulsions | Has there been a seizure or shaking fit? |
| `unable_to_drink` | Cannot drink or breastfeed | Can you drink fluids, or are you unable to keep anything down? |
| `vomits_everything` | Vomits everything | Do you vomit everything you eat or drink? |
| `very_sleepy` | Very sleepy or hard to wake | Have you been unusually sleepy, or hard to wake up? |
| `fever` | Fever | Do you have a fever, or feel hot? |
| `chills` | Chills, shivering then sweats | Do you get chills or shivering, and then break into a sweat? |
| `mosquito_bites` | Mosquito bites / no bed net | Have you had many mosquito bites lately, or do you sleep without a mosquito net? |
| `belly_pain` | Belly pain | Do you have pain in your belly? |
| `stiff_neck` | Stiff neck | Does it hurt to bend your neck forward? |
| `rash` | Rash or spots | Is there a rash or red spots on the skin? |
| `cough` | Cough | Do you have a cough? |
| `long_cough` | Cough for more than 2 weeks | Have you been coughing for more than two weeks? |
| `fast_breathing` | Fast breathing | Is the breathing faster than normal? |
| `chest_indrawing` | Chest indrawing | When breathing in, does the skin pull in under the ribs? |
| `wheeze` | Wheezing | Is there a whistling sound when breathing? |
| `diarrhea` | Diarrhea | Is there diarrhea? |
| `sunken_eyes` | Sunken eyes / very thirsty | Are the eyes sunken, or are they very thirsty? |
| `blood_in_stool` | Blood in stool | Is there blood in the stool? |
| `pregnant` | Pregnant | Are you pregnant? |
| `severe_bleeding` | Heavy bleeding | Is there heavy bleeding that won't stop? |
| `injury` | Injury | Were you hurt in an accident or a fall? |
| `deep_wound` | Deep or gaping wound | Is the cut deep or wide, or does it gape open when you move? |
| `dirty_wound` | Dirty wound / bite | Was it a dirty or rusty object, or an animal bite? |
| `tetanus_recent` | Tetanus shot in last 5 years | Have you had a tetanus shot in the last five years? |
| `yellow_eyes` | Yellow eyes or skin | Are the eyes or skin yellow? |
| `pale` | Very pale | Have you been very pale or tired lately? |
| `blue_lips` | Blue lips | Are the lips or fingertips turning blue? |
| `very_thin` | Very thin / wasting | Has there been a lot of weight loss? |
| `balance_problem` | Unsteady / loss of balance | Do you feel dizzy or unsteady when you walk? |
| `leg_weakness` | Leg weakness / hard to stand | Are your legs weak, or is it hard to stand up? |
| `back_pain` | Back pain | Do you have pain in your back? |
| `pain_on_bending` | Pain when bending | Did that hurt when you bent over? |
| `bladder_control` | Lost bladder or bowel control | Have you lost control of your bladder or bowels? |
| `swollen_feet` | Swelling of both feet | Are both feet swollen? |
| `low_mood` | Feeling down or hopeless | In the last two weeks, have you felt down, sad or hopeless on most days? |
| `little_interest` | Little interest or pleasure | In the last two weeks, have you had little interest or pleasure in doing things? |
| `anxious` | Nervous or on edge | Have you felt nervous, anxious or on edge on most days? |
| `cant_stop_worrying` | Can't stop worrying | Have you been unable to stop or control worrying? |
| `self_harm_thoughts` | Thoughts of ending their life | Sometimes when people feel this way, they think about ending their life. Have you had thoughts like that? |
| `trauma_or_loss` | Recent loss, violence or hardship | Has something very hard happened recently, like a loss or violence? |
| `lonely` | Lonely or isolated | How often do you feel alone, left out, or without people to talk to? |
| `wants_peer_group` | Wants a peer support group | There are people near you who meet regularly to talk and support each other, with a trained counselor. Would you like the health worker to introduce you? |

### Physical tests (the camera watches a few seconds of pictures)

- **finger** - Oxygen + pulse (finger sensor): "Please rest your index finger on the red sensor and keep still for fifteen seconds."
- **smile** - Smile test: "Please give me a big smile, showing your teeth."
- **arm_drift** - Arm drift test: "Close your eyes and hold both arms straight out in front of you, palms up, until I say stop."
- **squat** - Crouch and stand: "Please crouch down slowly, then stand back up."
- **bend** - Forward bend: "Please bend forward slowly, as if to touch your toes, then stand up."
- **chest_show** - Chest check (child): "Please lift the child's shirt so I can see the chest and belly while they breathe calmly."
- **palms** - Palm check: "Please hold both hands open toward the camera, palms facing me."
- **feet** - Foot swelling check: "Please press your thumb on the top of each foot for three seconds, then show the feet to the camera."

## 5. Pathways, conditions, and what gets sent

### Stroke / brain (`stroke`)

Opens on: face_or_arm_weakness, confused_speech, balance_problem. Asks in order: test:smile, face_or_arm_weakness, test:arm_drift, confused_speech, sudden_onset, test:walk_line, severe_headache.

| condition | urgency | what it looks like | sent to the patient's home |
|---|---|---|---|
| Stroke | red | Sudden face droop, arm weakness or speech trouble | (services only: referral, transport, review) |
| Low blood sugar | red | Confusion or weakness in a diabetic or someone who has not eaten | 1× Glucose gel |
| Bell's palsy | yellow | Only the face is weak, came on over a day, no arm or speech problem | (services only: referral, transport, review) |
| Migraine | green | Headache with temporary vision or sensation changes, history of similar episodes | 1× Paracetamol |

### Chest pain / heart (`cardiac`)

Opens on: chest_pain. Asks in order: pain_spreads, sweating, short_of_breath, sudden_onset.

| condition | urgency | what it looks like | sent to the patient's home |
|---|---|---|---|
| Heart attack | red | Crushing or pressure pain, spreading to arm/jaw, sweating, breathlessness | 1× Aspirin |
| Angina | yellow | Chest pain on exertion that settles with rest | (services only: referral, transport, review) |
| Chest infection | yellow | Chest pain with cough and fever | 1× Amoxicillin |
| Muscle or reflux pain | green | Pain that changes with movement, pressing, or after meals | 1× Paracetamol |

### Breathing / cough (`breathing`)

Opens on: cough, short_of_breath, fast_breathing, wheeze. Asks in order: test:chest_show, chest_indrawing, unable_to_drink, fast_breathing, short_of_breath, fever, wheeze, long_cough.

| condition | urgency | what it looks like | sent to the patient's home |
|---|---|---|---|
| Severe pneumonia | red | Chest indrawing, cannot drink, very sleepy, or blue lips with cough or fast breathing | 1× Oxygen cylinder, 1× Ceftriaxone (pre-referral) |
| Pneumonia | yellow | Cough with fast breathing, often fever, no danger signs | 1× Amoxicillin |
| Asthma attack | yellow | Wheezing and breathlessness, often known asthma | 1× Salbutamol inhaler |
| Tuberculosis (suspected) | yellow | Cough for more than 2 weeks, weight loss, night sweats | (services only: referral, transport, review) |
| Common cold | green | Cough or runny nose, normal breathing, no danger signs | 1× Paracetamol |

### Fever (`fever`)

Opens on: fever, chills. Asks in order: very_sleepy, seizure, unable_to_drink, stiff_neck, chills, mosquito_bites, rash, yellow_eyes, test:palms, vomits_everything.

| condition | urgency | what it looks like | sent to the patient's home |
|---|---|---|---|
| Severe malaria | red | Fever (often with chills, mosquito bites or no bed net) plus convulsions, very sleepy, cannot drink, yellow eyes or very pale | (services only: referral, transport, review) |
| Meningitis | red | Fever with stiff neck, severe headache, rash or confusion | 1× Ceftriaxone (pre-referral) |
| Malaria | yellow | Fever with chills and sweats, often after many mosquito bites or sleeping without a net, in a malaria area, without danger signs | (services only: referral, transport, review) |
| Dengue | yellow | Fever with rash, body and eye pain, in a dengue area | 1× Paracetamol, 2× Oral rehydration salts |
| Fever from another infection | yellow | The fever goes with a cough, a chest or urine problem, or an illness lasting weeks (TB): test for malaria, but the cause is elsewhere | 1× Malaria rapid test |
| Viral fever | green | Fever with no danger signs and no specific pattern | 1× Paracetamol, 1× Malaria rapid test |

### Diarrhea / vomiting (`stomach`)

Opens on: diarrhea, vomits_everything, belly_pain. Asks in order: unable_to_drink, very_sleepy, sunken_eyes, blood_in_stool, vomits_everything, diarrhea, fever, test:feet.

| condition | urgency | what it looks like | sent to the patient's home |
|---|---|---|---|
| Severe dehydration | red | Very sleepy, cannot drink, sunken eyes | 1× IV fluids, 2× Oral rehydration salts |
| Some dehydration | yellow | Sunken eyes or very thirsty, still drinking | 2× Oral rehydration salts, 1× Zinc |
| Dysentery | yellow | Blood in the stool | 2× Oral rehydration salts, 1× Ceftriaxone (pre-referral) |
| Diarrhea without dehydration | green | Loose stools, drinking normally, alert | 2× Oral rehydration salts, 1× Zinc |

### Pregnancy (`pregnancy`)

Opens on: pregnant. Asks in order: severe_bleeding, severe_headache, seizure, test:feet, fever.

| condition | urgency | what it looks like | sent to the patient's home |
|---|---|---|---|
| Bleeding in pregnancy | red | Heavy vaginal bleeding | 1× Blood (O negative) |
| Pre-eclampsia | red | Severe headache, blurred vision, swelling or fits in pregnancy | (services only: referral, transport, review) |
| Infection in pregnancy | yellow | Fever in pregnancy | 1× Malaria rapid test |
| Routine pregnancy concern | green | No danger signs | (services only: referral, transport, review) |

### Injury / bleeding (`injury`)

Opens on: injury, severe_bleeding. Asks in order: severe_bleeding, deep_wound, dirty_wound, tetanus_recent, very_sleepy, short_of_breath.

| condition | urgency | what it looks like | sent to the patient's home |
|---|---|---|---|
| Major bleeding | red | Bleeding that will not stop, or a large wound | 1× Wound dressing kit, 1× Blood (O negative) |
| Possible fracture | yellow | Deformed or very painful limb after a fall | 1× Paracetamol |
| Wound needing care | yellow | A cut from a blade or tool, deep, gaping or dirty, that needs cleaning, closing and tetanus protection | 1× Wound dressing kit, 1× Tetanus vaccine |
| Minor injury | green | Small cut or bruise | 1× Wound dressing kit |

### Headache (`headache`)

Opens on: headache, worst_headache. Asks in order: worst_headache, fever, stiff_neck, chills, mosquito_bites, face_or_arm_weakness, light_hurts, severe_headache, pregnant.

| condition | urgency | what it looks like | sent to the patient's home |
|---|---|---|---|
| Bleeding in the brain | red | Sudden, worst-ever headache, maybe with vomiting or confusion | (services only: referral, transport, review) |
| Meningitis | red | Headache with fever and stiff neck, maybe rash or confusion | 1× Ceftriaxone (pre-referral) |
| High blood pressure | yellow | Headache with blurred vision, older age or known high pressure | (services only: referral, transport, review) |
| Fever headache (malaria or infection) | yellow | Headache with fever, no stiff neck | (services only: referral, transport, review) |
| Migraine | green | Throbbing headache, light hurts, maybe nausea, has happened before | 1× Paracetamol |
| Tension headache | green | Pressing headache from stress, tiredness or not eating, no danger signs | 1× Paracetamol |

### Back / joint pain (`pain`)

Opens on: back_pain, pain_on_bending, leg_weakness. Asks in order: bladder_control, leg_weakness, test:squat, test:bend, pain_on_bending, fever, injury.

| condition | urgency | what it looks like | sent to the patient's home |
|---|---|---|---|
| Spinal cord compression | red | Back pain with leg weakness or loss of bladder/bowel control | (services only: referral, transport, review) |
| Kidney infection | yellow | Back or side pain with fever | (services only: referral, transport, review) |
| Sciatica / nerve pain | yellow | Pain shooting down one leg, worse on bending | 1× Paracetamol |
| Possible fracture | yellow | Pain after a fall, cannot bear weight | 1× Paracetamol |
| Muscle strain | green | Back pain after lifting or work, moves normally | 1× Paracetamol |

### Mental health (`mental`)

Opens on: low_mood, little_interest, anxious, cant_stop_worrying, self_harm_thoughts, trauma_or_loss, lonely. Asks in order: low_mood, little_interest, self_harm_thoughts, anxious, cant_stop_worrying, trauma_or_loss, lonely, wants_peer_group.

| condition | urgency | what it looks like | sent to the patient's home |
|---|---|---|---|
| Suicide risk | red | Thoughts of ending their life or self-harm | (services only: referral, transport, review) |
| Depression | yellow | Low mood or loss of interest on most days for two weeks or more | (services only: referral, transport, review) |
| Anxiety | yellow | Nervous, on edge, cannot stop worrying on most days | (services only: referral, transport, review) |
| Stress or grief reaction | green | Distress after a recent loss, violence or hardship | (services only: referral, transport, review) |
| Loneliness | green | Feels alone or cut off from people, without low mood most days | (services only: referral, transport, review) |

## 6. What the camera can notice, and what it asks next

Each trait is a Jev yes/no over the last three pictures. `finding` = counts as seen evidence; `ask` = the symptom confirmed with the patient first; `hint` = the pathway whose cause question follows. A trait at 60%+ (face droop 45%+) becomes a hunch: "I notice you look sweaty. Are you sweating a lot right now, even without heat?" then, if yes, "Do you have pain or pressure in your chest?"; if no, it is dropped.

| trait | group | what Jev is asked | leads to |
|---|---|---|---|
| One side of face drooping (`face_droop`) | Face & brain | Compare the two sides of the face: is one mouth corner, cheek or eyelid clearly lower, flatter or not moving like the other side, as in Bell's palsy or a stroke? | seen evidence for **face_or_arm_weakness** - says: "I notice one side of your face looks a little different." |
| Drooping eyelid (`eyelid_droop`) | Face & brain | Is one eyelid clearly lower than the other? | remark only |
| Eyes looking to one side (`gaze_off`) | Face & brain | Are both eyes fixed hard to one side in every picture, as if they cannot look the other way (not just glancing away or looking at a screen)? | then the **stroke** pathway |
| Looks confused or disoriented (`confused_look`) | Face & brain | Does the person look confused or disoriented? | then the **stroke** pathway |
| Mouth hanging open / drooling (`slack_mouth`) | Face & brain | Is the mouth hanging open or is the person drooling? | then the **stroke** pathway |
| Shaking or trembling (`tremor`) | Face & brain | Is the person shaking or trembling? | asks **chills**; then the **fever** pathway - says: "I notice you are shaking a little." |
| Jerking movements (`seizure_like`) | Face & brain | Are there sudden jerking movements of the face, arms or body, like a fit? | seen evidence for **seizure** |
| Yellow eyes (`yellow_eyes`) | Eyes | Are the whites of the eyes yellow? | seen evidence for **yellow_eyes** - says: "Your eyes look a little yellow." |
| Red eyes (`red_eyes`) | Eyes | Are the eyes red or bloodshot? | asks **fever**; then the **fever** pathway - says: "Your eyes look a little red." |
| Sunken eyes (`sunken_eyes`) | Eyes | Do the eyes look sunken into the face? | seen evidence for **sunken_eyes** |
| Puffy, swollen eyelids (`puffy_eyes`) | Eyes | Are the eyelids clearly puffy or swollen? | remark only |
| Discharge from eyes (`eye_discharge`) | Eyes | Is there pus or discharge around the eyes? | remark only |
| Tearful or crying (`tearful`) | Eyes | Is the person crying or visibly tearful? | seen evidence for **low_mood** - says: "You seem upset, and that's okay." |
| Eyes keep closing (`eyes_closing`) | Eyes | Do the person's eyes keep closing, as if they cannot stay awake? | seen evidence for **very_sleepy** |
| Very pale (`pale`) | Skin | Are the lips and inner eyelids almost white, much paler than this person's natural skin tone (not just bright or cold lighting)? | seen evidence for **pale** - says: "You look a bit pale." |
| Flushed, red face (`flushed`) | Skin | Is the face clearly flushed bright red, as with a high fever (not ordinary skin tone or warm lighting)? | asks **fever**; then the **fever** pathway - says: "Your face looks a little red." |
| Sweaty or clammy (`sweaty`) | Skin | Are there visible beads or drips of sweat on the face (not ordinary skin shine under lights)? | seen evidence for **sweating** - says: "I notice you are sweating." |
| Blue or grey lips (`blue_lips`) | Skin | Are the lips clearly blue or grey (not their normal pink or brown colour, not a shadow)? | seen evidence for **blue_lips** |
| Yellow skin (`yellow_skin`) | Skin | Is the skin clearly yellow, like jaundice (not warm or yellow lighting)? | seen evidence for **yellow_eyes** |
| Rash or red spots (`rash`) | Skin | Is there a visible rash or many red spots on the skin? | seen evidence for **rash** - says: "I see some spots on your skin." |
| Insect bite marks (`bite_marks`) | Skin | Are there several small red bumps on the skin that look like mosquito or insect bites (not a rash, not acne)? | asks **mosquito_bites** - says: "I see some bite marks on your skin." |
| Blisters or sores (`blisters`) | Skin | Are there blisters, open sores or crusted spots on the skin? | remark only |
| Bruises (`bruises`) | Skin | Are there visible bruises? | seen evidence for **injury** |
| Cut or open wound (`wound`) | Skin | Is there a visible cut or open wound? | seen evidence for **injury** - says: "I see a wound." |
| Active bleeding (`bleeding`) | Skin | Is there visible blood or an actively bleeding wound? | seen evidence for **severe_bleeding** |
| Burn (`burn`) | Skin | Is there a visible burn on the skin? | seen evidence for **injury** |
| Dry, cracked lips (`dry_lips`) | Skin | Are the lips clearly dry, cracked or peeling? | then the **stomach** pathway |
| Sores at the mouth corners (`mouth_sores`) | Skin | Are there sores or cracks at the corners of the mouth? | remark only |
| Struggling to breathe (`labored`) | Breathing | Does the person look like they are struggling to breathe (gasping, straining the neck)? | seen evidence for **short_of_breath** - says: "It looks a little hard for you to breathe." |
| Breathing through the mouth (`mouth_breathing`) | Breathing | Is the person breathing through an open mouth? | asks **short_of_breath**; then the **breathing** pathway - says: "I notice you are breathing through your mouth." |
| Nostrils flaring (`nostril_flare`) | Breathing | Do the nostrils flare out with each breath? | seen evidence for **short_of_breath** |
| Chest moving fast (`fast_chest`) | Breathing | Is the chest or belly moving up and down fast? | seen evidence for **fast_breathing** |
| Coughing (`coughing`) | Breathing | Is the person coughing in these pictures? | seen evidence for **cough** - says: "I heard you cough." |
| Runny nose or sneezing (`sneezing`) | Breathing | Does the person have a runny nose or are they sneezing? | then the **breathing** pathway |
| Face showing pain (`grimace`) | Pain & posture | Is the person grimacing or wincing in pain? | remark only - says: "It looks like something hurts." |
| Holding the chest (`holding_chest`) | Pain & posture | Is the person holding or pressing on their chest? | asks **chest_pain**; then the **cardiac** pathway - says: "I see you holding your chest." |
| Holding the head (`holding_head`) | Pain & posture | Is the person holding their head? | asks **headache**; then the **stroke** pathway - says: "I see you holding your head." |
| Holding the belly (`holding_belly`) | Pain & posture | Is the person holding their belly or stomach? | asks **belly_pain**; then the **stomach** pathway - says: "I see you holding your belly." |
| Holding the back (`holding_back`) | Pain & posture | Is the person holding their lower back? | asks **back_pain**; then the **pain** pathway - says: "I see you holding your back." |
| Protecting an arm or leg (`guarding_limb`) | Pain & posture | Is the person protecting or holding an arm or leg still, as if injured? | then the **injury** pathway |
| One arm hanging limp (`limp_arm`) | Pain & posture | Is one arm hanging limp or not moving like the other? | seen evidence for **face_or_arm_weakness** |
| Slumped, can't sit up (`slumped`) | Pain & posture | Is the person slumped over or unable to sit upright? | seen evidence for **very_sleepy** |
| Rocking or restless (`rocking`) | Pain & posture | Is the person rocking back and forth or very restless? | then the **mental** pathway |
| Sad expression (`sad`) | Mood & energy | Does the person look clearly sad or downcast (tearful, head down, mouth turned down), not just calm or neutral? | asks **low_mood**; then the **mental** pathway - says: "You seem a little down." |
| Anxious or frightened (`anxious`) | Mood & energy | Does the person look anxious, frightened or tense? | asks **anxious**; then the **mental** pathway - says: "You seem a little worried." |
| Flat, no expression (`flat`) | Mood & energy | Is the face strikingly blank and lifeless across all the pictures (dull eyes, no movement at all), well beyond an ordinary calm, neutral or concentrating face? | then the **mental** pathway |
| Agitated (`agitated`) | Mood & energy | Does the person look agitated or angry? | remark only |
| Exhausted (`exhausted`) | Mood & energy | Does the person look clearly exhausted (heavy eyelids, slumping), not just calm? | remark only - says: "You look tired." |
| Drowsy or limp (`drowsy`) | Mood & energy | Does the person look very drowsy, limp, or unable to keep their eyes open? | seen evidence for **very_sleepy** - says: "You look very sleepy." |
| Very thin / wasted (`very_thin`) | Nutrition | Does the person look severely underweight or wasted? | seen evidence for **very_thin** |
| Hollow cheeks (`hollow_cheeks`) | Nutrition | Are the cheeks hollow or sunken? | seen evidence for **very_thin** |
| Puffy, swollen face (`puffy_face`) | Nutrition | Is the face clearly puffy or swollen (moon-shaped), unlike a normal face? | then the **stomach** pathway |
| Swelling at the front of the neck (`neck_swelling`) | Nutrition | Is there a visible swelling at the front of the neck (goitre)? | remark only |
| Thin, pale or reddish hair (child) (`thin_hair`) | Nutrition | If a child is shown, is their hair thin, sparse, pale or reddish? | remark only |
| A child is present (`child_present`) | Who is here | Is there a child in the pictures? | remark only |
| Baby being held (`infant_held`) | Who is here | Is someone holding a baby? | remark only |
| Older adult (`elderly`) | Who is here | Does the main person look over 65 years old? | remark only |
| Visibly pregnant (`pregnant_belly`) | Who is here | Does the person look visibly pregnant? | seen evidence for **pregnant** |
| Using a cane or crutch (`walking_aid`) | Who is here | Is the person using a cane, crutch or walker? | then the **pain** pathway |
| Already bandaged (`bandage`) | Who is here | Is there a bandage or dressing on the body? | seen evidence for **injury** |
| Wearing a face mask (`mask`) | Who is here | Is the person wearing a face mask? | then the **breathing** pathway |

## 7. Safety rules (these override everything)

| rule | means | colour |
|---|---|---|
| `stroke_weakness_reported` | Possible stroke: patient reports one-sided face or arm weakness | red |
| `stroke_face_droop_camera` | Possible stroke: uneven smile confirmed twice | red |
| `stroke_speech` | Possible stroke: garbled speech test plus another stroke sign | red |
| `cardiac_chest_pain` | Possible heart attack: chest pain with warning signs | red |
| `child_danger_sign` | WHO danger sign in a child | red |
| `seizure_any_age` | Seizure | red |
| `severe_pneumonia` | Severe pneumonia sign: chest indrawing | red |
| `severe_bleeding` | Severe bleeding | red |
| `pregnancy_bleeding` | Heavy bleeding in pregnancy | red |
| `pregnancy_danger` | Pregnancy danger sign (possible pre-eclampsia) | red |
| `thunderclap_headache` | Sudden worst-ever headache (possible bleeding in the brain) | red |
| `meningitis_signs` | Headache or fever with stiff neck (possible meningitis) | red |
| `suicide_risk` | Thoughts of suicide or self-harm | red |
| `stroke_balance` | Possible stroke: sudden loss of balance | red |
| `spinal_cord` | Back pain with leg weakness or loss of bladder control | red |
| `child_malnutrition_oedema` | Swelling of both feet in a child (severe malnutrition sign) | red |
| `kidney_infection` | Back pain with fever (possible kidney infection) | yellow |
| `low_mood_screen` | Positive depression or anxiety screen (PHQ-2 / GAD-2) | yellow |
| `pneumonia` | Possible pneumonia: cough with fast breathing | yellow |
| `fever_malaria_test` | Fever: test for malaria | yellow |
| `dehydration` | Diarrhea with dehydration signs | yellow |
| `dysentery` | Blood in stool | yellow |
| `wound_care` | Wound that needs cleaning, closing and tetanus cover | yellow |
| `heart_rate_abnormal` | Heart rate outside normal range (camera estimate) | yellow |
| `low_oxygen` (measured) | Low oxygen level | red |
| `borderline_oxygen` (measured) | Borderline oxygen level | yellow |
| `very_high_fever` (measured) | Very high fever | yellow |
| `low_bp` (measured) | Low blood pressure (possible shock) | red |
| `low_sugar` (measured) | Low blood sugar | red |
| `high_sugar` (measured) | Very high blood sugar | yellow |

Measured vitals: SpO2 < 90 red, 90-93 yellow; temperature >= 40 yellow (>= 38 counts as fever); BP >= 160/110 red, >= 140/90 yellow, systolic < 90 red; glucose < 70 red, > 300 yellow.

## 8. Confidence: when a condition is named

- Each open pathway gets a Jev choice over its conditions (plus "Not sure yet"). Probability = pathway strength x Jev's pick x confidence, where confidence = 0.35 + 0.15 per answered question in that pathway (full after five).
- **Named** only if a safety rule backs it, or probability >= 0.70 with >= 2 separate findings and the pathway is past the early stage.
- Urgency comes from rules and named conditions only. Guesses never change the colour.
- The staff screen shows the top causes with "for / against" evidence so the worker sees why.

## 9. Real cases: what it saw, what it asked, what it concluded

Transcripts from simulated spoken patients (Claude plays the patient, Cartesia speaks and listens, the real engine answers). Trimmed to the pod's questions and the patient's answers.

### Healthy, neutral face, 'just a check-up'

Nothing on the camera. The pod skips the pain/timing questions, runs the mood screen, ends green with nothing ordered.

```
POD (intake:name): Hello, I'm the health pod. What's your name?
PATIENT: Hi, I'm Philip.
POD (intake:community): Nice to meet you, Philip. Where do you live?
PATIENT: I live in Katete, Zambia.
POD (intake:who): Thank you, Philip. Who is today's visit for, you or someone else like a child, and how old are they?
PATIENT: It's for me, I'm 21 years old.
POD (intake:consent): Thanks, Philip. May we save your name and what you need, so the health team can help you? Only the health team will see it.
PATIENT: Yes, that's fine, you can save it.
POD (open): Thanks, Philip, that's saved. What's bothering you the most today?
PATIENT: Nothing's really bothering me, I'm just here for a check-up and I feel okay.
POD (history:confirm): So you're feeling well and just here for a routine checkup, is that right?
PATIENT: Yes, that's right, I feel fine and just want a check-up.
POD (low_mood): In the last two weeks, have you felt down, sad or hopeless on most days?
PATIENT: No, my mood's been fine, I haven't felt down or hopeless.
POD (free): Good to hear, Philip. Lately, have you had any fever, cough, night sweats, or weight loss?
PATIENT: No, I haven't had any fever, cough, night sweats, or weight loss.
POD (free): Is there anything you'd like checked today, Philip, like blood pressure or an HIV test?
PATIENT: A blood pressure check would be good, thanks.
POD (little_interest): Sure, we'll check that, Philip. In the last two weeks, have you had little interest or pleasure in doing things?
PATIENT: No, I've still been enjoying things like usual.
POD (lonely): Glad you're still enjoying things, Philip. How often do you feel alone, left out, or like you don't have people to talk to?
PATIENT: Not really, I've got good friends and family I can talk to.
POD (history:else): Good friends and family help a lot. Is there anything else that worries you, or anything else you're feeling?
PATIENT: No, nothing else is worrying me, I'm feeling good.
POD (None): Thank you. Nothing worrying came up today, and you don't need any treatment right now. Keep drinking plenty of water and stay active, Philip. Come back right away if you get chest pain, a sudden severe headac
=== RESULT: green | No danger signs found; no single cause stands out | named: []
=== ORDERS: []
=== RESULT: green | No danger signs found; no single cause stands out | named: []
=== ORDERS: []
```

### Camera sees sweat and a red face; the patient is fine

Both signs are confirmed with the patient first; she says no to both; the pod drops them. Green, nothing ordered.

```
POD (intake:name): Hello, I'm the health pod. What's your name?
PATIENT: My name is Grace Mwanza.
POD (intake:community): Nice to meet you, Grace. Where do you live?
PATIENT: I live in Lundazi.
POD (intake:who): Thanks, Grace. Is today's visit for you or someone else, like a child, and how old is the person who needs care?
PATIENT: The visit is for me, I'm 28 years old and just here for a check-up.
POD (intake:consent): A checkup, good to know, Grace. May we save your name and what you need so the health team can help you? Only the health team will see it.
PATIENT: Yes, you may save it.
POD (sweating): Thank you, Grace. I notice you look a bit sweaty. Are you sweating a lot right now, even without heat or hard work?
PATIENT: No, I just walked here in the sun, but I'm not sweating now.
POD (open): That sun is strong, Grace. You mentioned a checkup. Is anything bothering you today, and if so, what bothers you the most?
PATIENT: No, nothing is bothering me, I feel fine and just want a check-up.
POD (history:confirm): Glad you're feeling well! You're here for a routine check-up, with nothing bothering you right now. Is that right?
PATIENT: Yes, that's right.
POD (fever): Thanks for confirming, Grace. Your face looks a little red. Do you have a fever, or do you feel hot?
PATIENT: No, I don't have a fever, I think my face is just red from walking in the sun.
POD (low_mood): That makes sense, Grace. In the last two weeks, have you felt down, sad or hopeless on most days?
PATIENT: No, I haven't felt down or sad, my mood has been fine.
POD (little_interest): Good to hear, Grace. In the last two weeks, have you had little interest or enjoyment in doing things you usually like?
PATIENT: No, I still enjoy doing the things I usually like.
POD (lonely): Nice to hear that, Grace. How often do you feel alone, left out, or like you have no one to talk to?
PATIENT: Hardly ever, I have family and friends I can talk to.
POD (history:else): That's lovely to have, Grace. Before we finish your checkup, is there anything else that worries you, or anything else you're feeling?
PATIENT: No, there's nothing else worrying me, I feel fine.
POD (None): Thank you. Nothing worrying came up today, and you don't need any treatment right now. Drink water and rest in the shade after walking in the sun. Come back right away if you feel dizzy, confused, faint, get 
=== RESULT: green | No danger signs found; no single cause stands out | named: []
=== ORDERS: []
```

### Only mentions a headache; camera sees sweat; chest pain comes out when asked

Sign confirmed, then the cause question: squeezing chest pressure. Red, heart attack, aspirin ordered.

```
POD (intake:name): Hello, I'm the health pod. What's your name?
PATIENT: My name is Bwalya Mbewe.
POD (intake:community): Nice to meet you, Bualya. Where do you live?
PATIENT: I live in Katete.
POD (intake:who): Thank you, Bualya. Is this visit for you or for someone else, like a child, and how old is the person we're seeing today?
PATIENT: It's for me, I'm 50 years old.
POD (intake:consent): Thank you, Bualya. May we save your name and what you need, so the health team can help you? Only the health team will see it.
PATIENT: Yes, that's fine, you can save it.
POD (sweating): Thank you, Bualya. I notice you look sweaty. Are you sweating a lot right now, even without heat or hard work?
PATIENT: Yes, I have been sweating a lot even just sitting still.
POD (open): Sweating even sitting still, okay. Bualya, what is bothering you the most today?
PATIENT: I have had a mild headache since this morning.
POD (history:confirm): I understand you've had a mild headache since this morning. Is that right?
PATIENT: Yes, that's right, just a mild headache since this morning.
POD (history:impact): Okay, thank you, Bualya. How is this headache affecting your day? Is there anything you can't do because of it?
PATIENT: It's not too bad, I can still do most things, I just feel a bit unwell.
POD (history:severity): Glad you can still manage most things. Bualya, on a scale from 1 to 10, how strong is your headache right now?
PATIENT: It's about a 3, not very strong.
POD (chest_pain): A three, okay. Bualya, do you have any pain or pressure in your chest?
PATIENT: Yes, there's been a squeezing pressure in the middle of my chest for about an hour.
POD (None): Stay calm. We are calling the doctor and getting you help right now. Please stay here with the health worker.
=== RESULT: red | Possible heart attack: chest pain with warning signs | named: ['Heart attack']
=== ORDERS: [('Aspirin', 1, 'Heart attack')]
```

### Fever, chills, sleeps without a net

Malaria pathway: danger signs first, then chills and mosquito bites. Yellow, malaria rapid test + ACT course ordered.

```
POD (intake:name): Hello, I'm the health pod. What's your name?
PATIENT: My name is Mercy Banda.
POD (intake:community): Nice to meet you, Mercy. Where do you live?
PATIENT: I live in Katete.
POD (intake:who): Thanks, Mercy, Katiti is noted. Who is today's visit for, you or someone else like a child, and how old is that person?
PATIENT: The visit is for me, I'm 30 years old, and it's Katete.
POD (intake:consent): Thank you, Mercy. May we save your name and what you need, so the health team can help? Only the health team will see it.
PATIENT: Yes, you can save it.
POD (open): Thank you for that, Mercy. What brings you in today, and what is bothering you the most?
PATIENT: I've had a fever with chills and shivering for three days, then I sweat a lot, and my head is aching.
POD (history:confirm): I understand you've had fever, chills, and shivering for three days, then heavy sweating and a headache. Is that right?
PATIENT: Yes, that's right.
POD (history:impact): Thanks for confirming. With this fever and headache, what has it stopped you from doing in your day, like work or chores?
PATIENT: I haven't been able to go to the field or do much housework because I feel so weak when the fever comes.
POD (history:severity): That sounds exhausting, Mercy, missing your fieldwork. From 1 to 10, how strong is what you're feeling right now?
PATIENT: Right now I would say about a 6, but when the fever and shivering come it feels like an 8.
POD (very_sleepy): An 8 sounds really rough, Mercy. Have you been very sleepy, or has anyone found it hard to wake you up?
PATIENT: No, I'm awake and alert, and nobody has had trouble waking me.
POD (seizure): Good that you're alert, Mercy. Apart from the shivering with chills, have you had a seizure or a shaking fit?
PATIENT: No, I haven't had any seizures or fits, just the shivering when the fever comes.
POD (unable_to_drink): Okay, no fits, that's good. Mercy, are you able to drink water and other fluids, or does everything come back up?
PATIENT: Yes, I can drink water and eat, and nothing has been coming back up.
POD (stiff_neck): Glad you're keeping food down, Mercy. With this headache, does it hurt when you bend your neck forward, like bringing your chin toward your chest?
PATIENT: No, I can bend my chin to my chest without any pain.
POD (mosquito_bites): Good, no neck pain. Mercy, have you had lots of mosquito bites lately, maybe out in the fields, or do you sleep without a mosquito net?
PATIENT: Yes, I sleep without a mosquito net and I get bitten a lot.
POD (rash): Thanks for telling me, Mercy. Have you noticed any rash or red spots anywhere on your skin?
PATIENT: No, I haven't noticed any rash or spots on my skin.
POD (yellow_eyes): Okay, no rash. Mercy, have you or anyone around you noticed a yellow color in your eyes or on your skin?
PATIENT: No, nobody has noticed any yellow in my eyes or on my skin.
POD (test:palms): Please hold both hands open toward the camera, palms facing me.
POD (worst_headache): Did the headache start suddenly, like a blow, and is it the worst you have ever had?
PATIENT: No, it came on slowly with the fever, and it's not the worst headache I've ever had.
POD (face_or_arm_weakness): Okay, it came on slowly. Mercy, have you noticed one side of your face or one arm feeling weak or numb?
PATIENT: No, my face and arms feel normal, with no weakness or numbness.
POD (history:else): Good, your face and arms feel normal. Mercy, is there anything else that worries you, or anything else you're feeling?
PATIENT: No, that's everything, I'm just worried it might be malaria because I get bitten so much.
POD (None): Thank you. The health worker will start treatment, and a doctor will review your case today. Keep drinking plenty of water and rest. Come back right away if you have a fit, vomit everything, get confused or v
=== RESULT: yellow | Most likely: Malaria | named: ['Malaria', 'Fever headache (malaria or infection)']
=== ORDERS: [('Malaria rapid test', 1, 'Malaria'), ('Antimalarial (ACT)', 1, 'Malaria'), ('Paracetamol', 1, 'Fever headache (malaria or infection)')]
```

### Mother with a 1-year-old: fever, very sleepy, cannot feed, a fit this morning

Danger sign red at once; the pod still asks the fever questions, names severe malaria; rectal artesunate + ceftriaxone + test ordered.

```
POD (intake:name): Hello, I'm the health pod. What's your name?
PATIENT: My name is Agnes Phiri, and this is my daughter Mary; she is very sick.
POD (intake:community): Thank you, Agnes, I'm here to help Mary. Where do you and Mary live?
PATIENT: We live in Petauke, here in Eastern Province.
POD (intake:who): Thank you, Agnes. So today's visit is for Mary. How old is she?
PATIENT: She is one year old.
POD (intake:consent): One year old, okay. Agnes, may we save your name and what Mary needs, so the health team can help her? Only the health team will see it.
PATIENT: Yes, you can save it, but please help her quickly.
POD (open): Thank you, Agnes. I'm checking Mary now, and the health worker and a doctor will explain and help her as quickly as we can. Thank you. What brings you in today? Tell me what is bothering you the most.
PATIENT: Mary has had a fever for two days, she is very sleepy and hard to wake, she cannot breastfeed, and this morning she had a shaking fit.
POD (stiff_neck): We are calling for help now. While it comes, let's do a few quick checks. Does it hurt to bend your neck forward?
PATIENT: She is too small to tell me, and she is so sleepy she hardly cries when I move her.
POD (chills): Do you get chills or shivering, and then break into a sweat?
PATIENT: Yes, her body gets hot and she shivers, then she sweats a lot, especially at night.
POD (mosquito_bites): Have you had many mosquito bites lately, or do you sleep without a mosquito net?
PATIENT: Yes, we sleep without a mosquito net, and there are many mosquitoes at night.
POD (None): Stay calm. We are calling the doctor and getting you help right now. Please stay here with the health worker.
=== RESULT: red | WHO danger sign in a child | named: ['Severe malaria']
=== ORDERS: [('Malaria rapid test', 1, 'Severe malaria'), ('Rectal artesunate', 1, 'Severe malaria'), ('Ceftriaxone (pre-referral)', 1, 'WHO danger sign in a child')]
```

### Child with cough and fast breathing

Pneumonia rule fires; amoxicillin and (fever in a malaria area) a rapid test ordered. Yellow.

```
POD (intake:name): Hello, I'm the health pod. What's your name?
PATIENT: My name is Agnes Phiri, and I've brought my son Chanda because he's been coughing and breathing fast.
POD (intake:community): Thank you for bringing Chanda in, Agnes. Where do you and Chanda live?
PATIENT: We live in Petauke.
POD (intake:who): Thanks, Agnes. Is today's visit just for Chanda, and how old is he?
PATIENT: Yes, it's just for Chanda, and he is two years old.
POD (intake:consent): Thank you, Agnes. May we save your name and Chanda's cough and fast breathing, so the health team can help? Only the health team will see it.
PATIENT: Yes, you may save it.
POD (open): Thanks, Agnes. You mentioned Chanda's cough and fast breathing. What is bothering him the most today?
PATIENT: The fast breathing worries me most, and he's had the cough for four days now with a little fever.
POD (history:confirm): I understand he's had a cough and slight fever for four days, and his fast breathing worries you most. Is that right?
PATIENT: Yes, that's right.
POD (history:onset): Thanks for confirming, Agnes. When did you first notice Chanda breathing fast like this?
PATIENT: I noticed it yesterday, it seemed to start a day or two after the cough began.
POD (history:impact): That helps, Agnes. How is the fast breathing affecting Chanda's day, like eating, drinking, playing, or sleeping, and is there anything he can't do now?
PATIENT: He's still drinking and breastfeeding well and playing like normal, so there's nothing he can't do.
POD (history:severity): Good to hear he's playing, Agnes. From 1 to 10, how strong is Chanda's fast breathing right now?
PATIENT: I'm not sure about numbers, but maybe around a 5, it's fast but he doesn't seem to be struggling.
POD (vomits_everything): That's helpful, Agnes. Is Chanda throwing up everything he eats or drinks, including breast milk?
PATIENT: No, he isn't vomiting at all, he keeps everything down.
POD (seizure): Good, he's keeping everything down. Has Chanda had any seizure or shaking fit since this started?
PATIENT: No, he hasn't had any fits or shaking at all.
POD (very_sleepy): Okay, no fits at all. Is Chanda very sleepy these days, or hard to wake up?
PATIENT: No, he's awake and playful, not sleepy at all.
POD (test:chest_show): Please lift the child's shirt so I can see the chest and belly while they breathe calmly.
POD (chest_indrawing): When breathing in, does the skin pull in under the ribs?
PATIENT: No, the skin under his ribs doesn't pull in when he breathes.
POD (wheeze): Good, no pulling in. Agnes, when Chanda breathes, do you hear a whistling sound?
PATIENT: No, I don't hear any whistling when he breathes.
POD (stiff_neck): Okay, no whistling. Agnes, does it seem to hurt Chanda when he bends his neck forward, like bringing his chin down to his chest?
PATIENT: No, he can bend his neck and put his chin to his chest without any pain.
POD (chills): Good, his neck moves fine. Agnes, does Chanda get chills or shivering, and then break into a sweat?
PATIENT: No, I haven't seen him shivering or sweating, he just feels a little warm.
POD (mosquito_bites): Okay, just a little warm. Agnes, has Chanda had many mosquito bites lately, or does he sleep without a mosquito net?
PATIENT: No, he sleeps under a mosquito net every night, and I haven't noticed many bites.
POD (rash): Good, the net helps a lot. Agnes, have you noticed any rash or red spots on Chanda's skin?
PATIENT: No, I haven't seen any rash or red spots on his skin.
POD (history:else): Is there anything else that worries you, or anything else you feel?
PATIENT: No, that's everything, I just want to know why he is breathing so fast.
POD (None): Agnes, fast breathing can mean his lungs are working hard, maybe from a chest infection. The health worker and doctor will check him and explain. Thank you. The health worker will start treatment, and a docto
=== RESULT: yellow | Most likely: Pneumonia | named: ['Pneumonia']
=== ORDERS: [('Amoxicillin', 1, 'Pneumonia'), ('Malaria rapid test', 1, 'Fever: test for malaria')]
```

### Sudden left-arm weakness and slurred speech

Red immediately; smile, arm-drift and speech checks still run so the doctor gets the full picture. No medicine shipped (transport).

```
POD (intake:name): Hello, I'm the health pod. What's your name?
PATIENT: My name is Moses Zulu, and my left arm feels weak and my face feels funny.
POD (test:smile): We are calling for help now. While it comes, let's do a few quick checks. Please give me a big smile, showing your teeth.
POD (test:arm_drift): Close your eyes and hold both arms straight out in front of you, palms up, until I say stop.
POD (confused_speech): Please repeat after me: "Today the sky is blue and the river is calm."
PATIENT: "Today the sky... is blue and the river... is calm," but my words feel thick and slow.
POD (None): Stay calm. We are calling the doctor and getting you help right now. Please stay here with the health worker.
=== RESULT: red | Possible stroke: patient reports one-sided face or arm weakness | named: ['Stroke']
=== ORDERS: []
```

### Fever patient who asks 'what do you think is wrong with me?'

The pod answers in one or two sentences, then returns to the question she side-stepped.

```
POD (intake:name): Hello, I'm the health pod. What's your name?
PATIENT: My name is Mercy Lungu.
POD (intake:community): Nice to meet you, Mercy. Where do you live?
PATIENT: I live in Katete.
POD (intake:who): Thanks, Mercy. Who's the visit for today, you or someone else like a child, and how old is that person?
PATIENT: It's for me, I'm 40 years old.
POD (intake:consent): May we save your name and what you need, so the health team can help you? Only the health team will see it.
PATIENT: Yes, that's okay with me.
POD (open): Thank you. What brings you in today? Tell me what is bothering you the most.
PATIENT: I've had a fever for two days and a headache.
POD (history:confirm): I understand you've had a fever and a headache for two days, is that right?
PATIENT: Yes, that's right, fever and headache for two days.
POD (history:impact): Thanks for confirming, Mercy. Is the fever and headache stopping you from doing anything you'd normally do during your day?
PATIENT: What do you think is wrong with me?
POD (history:severity): I can't say for sure yet, Mercy. We're checking your fever and headache, and the health worker and a doctor will explain and help you. From 1 to 10, how strong is it right now?
PATIENT: It's about a 6 right now.
POD (very_sleepy): Okay, a 6, thank you. Mercy, are you feeling very sleepy, or has anyone found it hard to wake you up?
PATIENT: No, I'm not sleepy, I'm awake and alert.
POD (seizure): Good, that's helpful to know. Mercy, since the fever started, have you had a seizure or a shaking fit?
PATIENT: Is this serious?
POD (unable_to_drink): Mercy, it needs attention, and it's good you came today. We're checking your fever and headache, and the health worker and doctor will explain and help. Can you drink fluids, or are you unable to k
PATIENT: Yes, I'm drinking fine and keeping it down.
POD (stiff_neck): Does it hurt to bend your neck forward?
PATIENT: No, bending my neck forward doesn't hurt.
POD (chills): Okay, no neck pain, good. Mercy, with this fever, do you get chills or shivering, and then break into a sweat?
PATIENT: Yes, I get some chills and then I sweat.
POD (mosquito_bites): Chills, then sweating, okay. Mercy, have you had many mosquito bites lately, or do you sleep without a mosquito net in Katady?
PATIENT: Yes, there are many mosquitoes here, and our net has some holes in it.
POD (rash): A net with holes, I see. Mercy, have you noticed any rash or red spots on your skin?
PATIENT: No, I haven't noticed any rash or spots on my skin.
POD (yellow_eyes): No rash, that's good to know. Have you or anyone at home noticed your eyes or skin looking yellow?
PATIENT: No, nobody has noticed my eyes or skin looking yellow.
POD (test:palms): Please hold both hands open toward the camera, palms facing me.
POD (worst_headache): Did the headache start suddenly, like a blow, and is it the worst you have ever had?
PATIENT: No, it came on slowly with the fever, and it's not the worst I've ever had.
POD (history:else): Came on slowly, okay, thank you. Mercy, is there anything else that worries you, or anything else you're feeling?
PATIENT: No, that's everything, just the fever, headache, and the chills.
POD (None): Thank you. The health worker will start treatment, and a doctor will review your case today. Rest, drink water, and come back right away if it gets much worse, or if you get a high fever, trouble breathing, o
=== RESULT: yellow | Most likely: Malaria | named: ['Malaria', 'Fever headache (malaria or infection)']
=== ORDERS: [('Malaria rapid test', 1, 'Malaria'), ('Antimalarial (ACT)', 1, 'Malaria'), ('Paracetamol', 1, 'Fever headache (malaria or infection)')]
```

### Machete cut, bleeding mostly stopped

Deep, dirty, no tetanus shot: wound-care rule; dressing kit + tetanus vaccine ordered. Yellow.

```
POD (intake:name): Hello, I'm the health pod. What's your name?
PATIENT: My name is Peter Daka, and I cut my hand on a machete about two hours ago.
POD (intake:community): Thanks, Peter, sorry about that machete cut. Before we look at your hand, where do you live?
PATIENT: I live in Petauke, here in Zambia.
POD (intake:who): Is this visit for you or for someone else, like a child? How old are they?
PATIENT: It's for me, I'm 35 years old.
POD (intake:consent): Thanks, Peter. May we save your name and your machete cut, so the health team can help you? Only the health team will see it.
PATIENT: Yes, you can save it, that's fine with me.
POD (open): Thanks for that, Peter. What's bothering you the most today, whether it's the machete cut on your hand or anything else?
PATIENT: It's just the cut on my hand. It's stopped bleeding mostly, but it opens a little when I spread my fingers, and the machete was dirty from the field.
POD (history:confirm): I understand you cut your hand on a dirty machete; it mostly stopped bleeding but reopens when you spread your fingers. Is that right?
PATIENT: Yes, that's right.
POD (history:impact): Thanks, Peter. How is that cut affecting your day? Is there anything, like your field work, that you can't do because of it?
PATIENT: I can't hold my hoe or work in the field right now because it hurts and the cut opens when I grip.
POD (history:severity): That sounds hard with field work, Peter. From 1 to 10, how strong is the pain in your hand right now?
PATIENT: It's about a 5 right now, but it gets worse when I try to grip something.
POD (tetanus_recent): Gripping makes it worse, okay. Peter, have you had a tetanus shot in the last five years?
PATIENT: No, I can't remember ever having a tetanus shot.
POD (history:onset): Okay, thanks for telling me, Peter. When exactly did the cut happen, and have you felt this way ever since?
PATIENT: It happened about two hours ago in the field, and it's been the same since then, just sore and stopped bleeding mostly with the cloth.
POD (very_sleepy): Two hours, mostly stopped bleeding, okay. Since you cut your hand, Peter, have you been unusually sleepy, or has anyone found you hard to wake up?
PATIENT: No, I'm not sleepy at all, I feel awake and fine apart from my hand.
POD (short_of_breath): Good to hear you feel awake, Peter. Is it hard for you to breathe right now?
PATIENT: No, my breathing is fine.
POD (back_pain): Glad your breathing is fine, Peter. Do you have any pain in your back?
PATIENT: No, my back is fine, it's only my hand that hurts.
POD (bladder_control): Okay, just your hand then. Peter, since this happened, have you had any trouble holding your urine or your stool, like leaking or not being able to stop it?
PATIENT: No, I haven't had any trouble with that at all.
POD (leg_weakness): Good, no trouble there. Peter, do your legs feel weak, or is it hard for you to stand up?
PATIENT: No, my legs are strong and I can stand up fine.
POD (history:else): Good, strong legs. Peter, besides the cut on your hand, is there anything else that worries you, or anything else you feel?
PATIENT: No, just the cut on my hand, and I'm a bit worried about getting tetanus since the machete was dirty and I never had the shot.
POD (test:squat): Please crouch down slowly, then stand back up.
POD (test:bend): Please bend forward slowly, as if to touch your toes, then stand up.
POD (pain_on_bending): Did that hurt when you bent over?
PATIENT: No, bending over didn't hurt at all, only my hand is sore.
POD (None): Thank you. The health worker will start treatment, and a doctor will review your case today. Gently rinse the cut with clean water, cover it with a clean cloth, and keep your hand raised. Come back right away
=== RESULT: yellow | Most likely: Wound needing care | named: ['Wound needing care']
=== ORDERS: [('Wound dressing kit', 1, 'Wound needing care'), ('Tetanus vaccine', 1, 'Wound needing care')]
```

### Rosa, Guatemala, Spanish: child with cough and fever for 4 days

Spanish throughout; pneumonia; amoxicillin + malaria test.

```
POD (intake:name): Hola, soy el asistente de salud. ¿Cómo se llama? Hello, what's your name?
PATIENT: Me llamo Rosa, y traigo a mi hijo Luis porque tiene tos y calentura.
POD (intake:community): Gracias, doña Rosa, ya vamos a ver a Luis. ¿En qué comunidad o lugar viven ustedes?
PATIENT: Vivimos aquí en Cobán.
POD (intake:who): Ah, de Cobán, qué bueno. Doña Rosa, ¿la consulta es solo para Luis, y cuántos años tiene él?
PATIENT: Sí, solo es para Luis, tiene 3 años.
POD (intake:consent): ¿Está de acuerdo en que guardemos su nombre y lo que necesita, para que el equipo de salud le pueda ayudar? Solo el equipo de salud lo verá.
PATIENT: Sí, está bien, estoy de acuerdo.
POD (open): Gracias, doña Rosa. Cuénteme, de lo que tiene Luis, ¿qué es lo que más le preocupa o le molesta a él hoy?
PATIENT: Lo que más me preocupa es que tiene tos y calentura desde hace cuatro días, y lo veo respirando muy rápido.
POD (history:confirm): Entiendo que él tiene tos y calentura desde hace cuatro días y lo ve respirando muy rápido, ¿es así?
PATIENT: Sí, así es, y eso es lo que más me tiene preocupada.
POD (history:impact): ¿Cómo le está afectando en su día? ¿Hay algo que no pueda hacer por esto?
PATIENT: Pues sigue tomando sus líquidos bien y está despierto, pero lo noto más cansadito y no quiere jugar como siempre.
POD (history:severity): Pobrecito, más cansadito. Doña Rosa, del 1 al 10, ¿qué tan fuerte ve ahorita lo que tiene Luis?
PATIENT: Yo le pondría como un siete, porque me asusta cómo respira.
POD (vomits_everything): Ay, sí asusta, doña Rosa. Dígame, ¿Luis vomita todo lo que come o toma?
PATIENT: No, no vomita, todo lo que toma se le queda bien.
POD (seizure): Qué bueno que no vomita. Doña Rosa, ¿a Luis le han dado convulsiones o ataques, que se ponga a temblar o se quede tieso?
PATIENT: No, nunca le han dado ataques ni se ha puesto tieso.
POD (very_sleepy): Gracias a Dios, doña Rosa. ¿Y Luis está muy dormido o le cuesta despertarlo?
PATIENT: No, está despierto y alerta, solo un poco más cansadito.
POD (test:chest_show): Por favor, levántele la camisa al niño para ver el pecho y la panza mientras respira tranquilo.
POD (chest_indrawing): ¿Al respirar se le hunde la piel debajo de las costillas?
PATIENT: No, no se le hunde, solo respira rapidito.
POD (wheeze): Ah, va, doña Rosa. Cuando Luis respira, ¿se le oye como un silbidito en el pecho?
PATIENT: No, no le oigo ningún silbidito, solo lo veo respirar rápido.
POD (stiff_neck): Gracias por fijarse, doña Rosa. ¿A Luis le duele cuando dobla el cuello hacia adelante, como para mirarse el pecho?
PATIENT: No, mueve el cuello bien y no se queja de dolor.
POD (chills): ¿Le dan escalofríos o temblores, y luego suda mucho?
PATIENT: No, no le he visto escalofríos ni que sude mucho, solo lo siento calientito.
POD (mosquito_bites): Va pues, doña Rosa. ¿A Luis le han picado muchos zancudos últimamente, o duerme sin mosquitero?
PATIENT: Sí, a veces le pican los zancudos, y no siempre duerme con mosquitero.
POD (rash): Gracias por contarme, doña Rosa. ¿Le ha visto a Luis ronchas o manchitas rojas en la piel?
PATIENT: No, no le he visto ronchas ni manchitas en la piel.
POD (history:else): Muy bien, doña Rosa. ¿Hay algo más que le preocupe a usted, o algo más que Luis sienta o se queje?
PATIENT: No, eso es todo, solo me preocupa que respire tan rápido y que no se le quite la calentura.
POD (None): Gracias. El promotor de salud le va a dar tratamiento, y un doctor va a revisar su caso hoy. Doña Rosa, dele agüita o atolito seguido y que duerma con mosquitero. Regrese de inmediato si se le hunde la piel e
=== RESULT: yellow | Most likely: Pneumonia | named: ['Pneumonia', 'Fever from another infection']
=== ORDERS: [('Amoxicillin', 1, 'Pneumonia'), ('Malaria rapid test', 1, 'Fever from another infection')]
```

### Five-week cough, night sweats, weight loss

TB suspected, no antibiotics; fever with a long cough is no longer read as malaria.

```
POD (intake:name): Hello, I'm the health pod. What's your name?
PATIENT: My name is Lackson Zimba, and I have come because of this cough that won't go away.
POD (intake:community): Thank you, Laxon, I'm sorry about that cough. Where do you live?
PATIENT: I live in Chama, here in Muchinga Province.
POD (intake:who): Thanks, Laxon. Is this visit for your own cough or for someone else, like a child, and how old is the person who's sick?
PATIENT: It's for my own cough, and I am 45 years old.
POD (intake:consent): Thank you, Laxon. May we save your name and what you need for your cough, so the health team can help? Only they will see it.
PATIENT: Yes, you can save it so the health team can help me.
POD (open): Thanks for agreeing, Laxon. You mentioned the cough that won't go away. Please tell me, what is bothering you the most today?
PATIENT: The cough has been there for five weeks now, and I am also sweating at night and losing weight.
POD (history:confirm): I understand you've had a cough for five weeks, plus night sweats and weight loss. Is that right?
PATIENT: Yes, that is right, and I also get a mild fever that comes and goes.
POD (history:impact): Thanks for mentioning the fever, Laxon. With this cough, sweats and fever, what everyday things are you finding hard or unable to do?
PATIENT: I feel weak and tired, so it is hard to do my work in the field like before, but I can still eat and drink.
POD (history:severity): That sounds hard with field work, Laxon. From 1 to 10, with 10 the worst, how strong is your cough right now?
PATIENT: I would say it is about a 6, it bothers me a lot, especially at night.
POD (chest_indrawing): A six, especially at night, Laxon. When you breathe in, does the skin under your ribs pull inward?
PATIENT: No, the skin under my ribs does not pull in when I breathe.
POD (fast_breathing): Good, no pulling in there. Laxon, does your breathing feel faster than normal for you?
PATIENT: No, my breathing is normal, it is not fast.
POD (wheeze): Okay, breathing normal. Laxon, when you breathe, do you hear a whistling sound?
PATIENT: No, I don't hear any whistling when I breathe.
POD (very_sleepy): No whistling, good. Laxon, besides feeling tired, have you been unusually sleepy, or hard to wake up?
PATIENT: No, I am not unusually sleepy, I wake up normally, I just feel tired during the day.
POD (seizure): Waking normally, that's good. Laxon, have you had a seizure or a shaking fit?
PATIENT: No, I have not had any seizure or shaking fit.
POD (stiff_neck): No seizures, thank you. Laxon, when you bend your neck forward, chin toward your chest, does it hurt?
PATIENT: I bent my neck forward now, and it does not hurt.
POD (chills): No pain there, good. Besides the night sweats, do you get chills or shivering, and then break into a sweat?
PATIENT: No, I don't get chills or shivering, just the sweating at night.
POD (mosquito_bites): Just night sweats, okay. Laxon, lately in Chama, have mosquitoes been biting you a lot, or do you sleep without a mosquito net?
PATIENT: No, I always sleep under a mosquito net, so they don't bite me much.
POD (rash): Good, the net helps. Laxon, have you noticed any rash or red spots anywhere on your skin?
PATIENT: No, I have not seen any rash or red spots on my skin.
POD (yellow_eyes): No rash, that's helpful. Have you or anyone at home noticed a yellow color in the whites of your eyes or on your skin?
PATIENT: No, nobody has noticed any yellow color in my eyes or on my skin.
POD (history:else): No yellowing, good to know. Laxon, besides the cough, night sweats and weight loss, is there anything else that worries you, or anything else you feel?
PATIENT: I am worried this might be TB, because my neighbour had it, but otherwise I don't feel anything else.
POD (None): Thank you. The health worker will start treatment, and a doctor will review your case today. Rest, eat nourishing meals, drink plenty of clean water, and cover your cough. Come back immediately if you cough b
=== RESULT: yellow | Most likely: Tuberculosis (suspected) | named: ['Tuberculosis (suspected)']
=== ORDERS: [('Malaria rapid test', 1, 'Fever: test for malaria')]
```
