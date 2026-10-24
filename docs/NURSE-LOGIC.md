# Triage Pod — the nurse logic, question by question

Generated from the code on 2026-10-24. Three parts: (1) how a nurse evaluates a patient before the doctor and how the pod copies it; (2) the full if-then cascade: what opens what, what is asked next, what each answer does; (3) what the camera sees, what that triggers, and how joint tracking (YOLO26-pose) will extend the physical tests.

## 1. How a nurse evaluates a patient before the doctor, and how the pod copies it

A triage nurse does the same four things every time, in this order, and stops early the moment something dangerous shows up.

| Step | What the nurse does | What the pod does |
|---|---|---|
| **1. Look (first 10 seconds)** | The "across-the-room" assessment: skin colour, breathing effort, posture, is the person holding something, are they alert. Anything alarming jumps straight to the danger protocol. | Jev judges 61 signs over the last two seconds of pictures, 10 pictures a second. Alarming signs (struggling to breathe, blue lips, bleeding, a drooping face) become the opener; everything else becomes a question later, never a conclusion. |
| **2. ABCDE danger check** | Airway, Breathing, Circulation, Disability (brain), Exposure. Red flags: cannot breathe, heavy bleeding, chest pressure, one-sided weakness, fits, cannot be woken, pregnancy bleeding. | 30 safety rules in code (section 2 lists which answers fire them). A red rule calls help at once, asks at most three more danger questions (fits, bleeding, can they drink), then closes. |
| **3. Chief complaint + history** | "What brought you in?" then **OPQRST** for a symptom: Onset (when, sudden or slow), Provocation (what makes it worse), Quality, Region, Severity (1-10), Time (how long). And **SAMPLE**: Signs, Allergies, Medications, Past history, Last meal, Events. | "What brings you in?" + Claude restates it to confirm it heard right. Onset always; severity 1-10 only for pain stories; "what can't you do" when nothing specific opened. Allergies/medications are left to the health worker (next step for the staff screen). |
| **4. Focused assessment** | Only the body system the complaint points to. A headache gets a neuro and fever check, not a limb exam. Danger signs of that system first, then the questions that separate its likely causes. | The gate: only what the patient SAID opens an area (max two). Each area asks up to 4 questions, danger signs first, then the ones that separate its conditions. Camera signs are confirmed with the patient before they count. |
| **5. Vital signs** | Pulse, oxygen, temperature, blood pressure, glucose where available. Numbers override impressions. | Finger sensor (oxygen, pulse) and whatever the health worker types in; thresholds are rules (SpO2 < 90 red, BP >= 160/110 red, glucose < 70 red...). |
| **6. Acuity + disposition** | Assign a level (ESI 1-5 or Manchester red/orange/yellow/green/blue) and decide: resuscitate, see now, see soon, can wait, home. The nurse estimates probability, not diagnosis: "this needs a doctor today" vs "this can go home with advice". | Four verdicts: **emergency** (red rule), **likely** (a condition is confident: >= 70% after enough questions with >= 2 findings, or a benign one with the danger questions answered no), **uncertain** (an area opened, questions ran out: the cover kit is sent and the worker checks today), **nothing found**. Colour red/yellow/green. |
| **7. Safety-net** | What to do at home and exactly which signs mean come back now. | Claude's closing: what it most likely is in plain words, what is being sent, two self-care steps, the return-now signs. |

For children under five the pod follows WHO's IMCI order used by community health workers worldwide: general danger signs first (cannot drink/feed, vomits everything, convulsions, lethargic or unconscious), then the main symptoms (cough/fast breathing, diarrhoea/dehydration, fever, ear, malnutrition), then classify and treat or refer.

Where the pod is: the pod is a triage nurse, not a doctor. It estimates how likely it is that the person needs help now, and what the likely problem is, and orders the test and first treatment so the health worker is not waiting on a supply run. It does not replace examination by hands.

**Location matters.** The pod now carries a small epidemiology profile per region: malaria and dengue only exist where they are transmitted (Eastern Province Zambia yes, San Francisco no). Where there is no malaria, Jev is never offered "Malaria" as an option, the "test every fever for malaria" rule is off, the bed-net question is skipped, and no malaria test is ever sent.


## 2. The cascade: what opens what, what is asked next, what each answer does

Read it as: **if the patient says X** → area opens → questions in this order → **a yes to Y fires rule Z** (colour) → conditions Jev chooses between.

### If they say: face or arm weakness, slurred or confused speech, unsteady / loss of balance  →  **Stroke / brain** opens

| order | question asked | a YES does | a NO does |
|---|---|---|---|
| 1 | *Test: Smile test* — "Please give me a big smile, showing your teeth." | the camera judges the sign it looks for; a clear sign counts like a yes | counts against the conditions that need it |
| 2 | Is one side of your face or one arm weak or numb? | evidence for the conditions below | counts against those conditions; next question |
| 3 | *Test: Arm drift test* — "Close your eyes and hold both arms straight out in front of you, palms up, until I say stop." | the camera judges the sign it looks for; a clear sign counts like a yes | counts against the conditions that need it |
| 4 | Please repeat after me: \ | may fire **Possible stroke: garbled speech test plus another stroke sign** (red); may fire **Possible stroke: sudden loss of balance** (red) | counts against those conditions; next question |
| 5 | Did this start suddenly, within the last few hours? | may fire **Possible stroke: garbled speech test plus another stroke sign** (red); may fire **Possible stroke: sudden loss of balance** (red) | counts against those conditions; next question |
| 6 | *Test: walk_line* — "" | the camera judges the sign it looks for; a clear sign counts like a yes | counts against the conditions that need it |
| 7 | Do you have a very strong headache or blurry vision? | may fire **Pregnancy danger sign (possible pre-eclampsia)** (red); may fire **Possible stroke: sudden loss of balance** (red) | counts against those conditions; next question |

Jev then chooses between: **Stroke** (red): Sudden face droop, arm weakness or speech trouble; **Low blood sugar** (red): Confusion or weakness in a diabetic or someone who has not eaten; **Bell's palsy** (yellow): Only the face is weak, came on over a day, no arm or speech problem; **Migraine** (green): Headache with temporary vision or sensation changes, history of similar episodes

### If they say: chest pain or pressure  →  **Chest pain / heart** opens

| order | question asked | a YES does | a NO does |
|---|---|---|---|
| 1 | Does the pain move to your arm, jaw or back? | may fire **Possible heart attack: chest pain with warning signs** (red) | counts against those conditions; next question |
| 2 | Are you sweating a lot right now, or breaking into a cold sweat, even without heat or hard work? | may fire **Possible heart attack: chest pain with warning signs** (red) | counts against those conditions; next question |
| 3 | Is it hard to breathe right now? | may fire **Possible heart attack: chest pain with warning signs** (red) | counts against those conditions; next question |
| 4 | Did this start suddenly, within the last few hours? | may fire **Possible stroke: garbled speech test plus another stroke sign** (red); may fire **Possible stroke: sudden loss of balance** (red) | counts against those conditions; next question |

Jev then chooses between: **Heart attack** (red): Crushing or pressure pain, spreading to arm/jaw, sweating, breathlessness; **Angina** (yellow): Chest pain on exertion that settles with rest; **Chest infection** (yellow): Chest pain with cough and fever; **Muscle or reflux pain** (green): Pain that changes with movement, pressing, or after meals

### If they say: cough, short of breath, fast breathing, wheezing  →  **Breathing / cough** opens

| order | question asked | a YES does | a NO does |
|---|---|---|---|
| 1 | *Test: Chest check (child)* — "Please lift the child's shirt so I can see the chest and belly while they breathe calmly." | the camera judges the sign it looks for; a clear sign counts like a yes | counts against the conditions that need it |
| 2 | When breathing in, does the skin pull in under the ribs? | may fire **Severe pneumonia sign: chest indrawing** (red) | counts against those conditions; next question |
| 3 | Can you drink fluids, or are you unable to keep anything down? | may fire **WHO danger sign in a child** (red) | counts against those conditions; next question |
| 4 | Is the breathing faster than normal? | may fire **Possible pneumonia: cough with fast breathing** (yellow) | counts against those conditions; next question |
| 5 | Is it hard to breathe right now? | may fire **Possible heart attack: chest pain with warning signs** (red) | counts against those conditions; next question |
| 6 | Do you have a fever, or feel hot? | may fire **Headache or fever with stiff neck (possible meningitis)** (red); may fire **Back pain with fever (possible kidney infection)** (yellow); may fire **Fever: test for malaria** (yellow) | counts against those conditions; next question |
| 7 | Is there a whistling sound when breathing? | evidence for the conditions below | counts against those conditions; next question |
| 8 | Have you been coughing for more than two weeks? | evidence for the conditions below | counts against those conditions; next question |

Jev then chooses between: **Severe pneumonia** (red): Chest indrawing, cannot drink, very sleepy, or blue lips with cough or fast breathing; **Pneumonia** (yellow): Cough with fast breathing, often fever, no danger signs; **Asthma attack** (yellow): Wheezing and breathlessness, often known asthma; **Tuberculosis (suspected)** (yellow): Cough for more than 2 weeks, weight loss, night sweats; **Common cold** (green): Cough or runny nose, normal breathing, no danger signs

### If they say: fever, chills, shivering then sweats  →  **Fever** opens

| order | question asked | a YES does | a NO does |
|---|---|---|---|
| 1 | Have you been unusually sleepy, or hard to wake up? | may fire **WHO danger sign in a child** (red) | counts against those conditions; next question |
| 2 | Has there been a seizure or shaking fit? | may fire **WHO danger sign in a child** (red); may fire **Seizure** (red) | counts against those conditions; next question |
| 3 | Can you drink fluids, or are you unable to keep anything down? | may fire **WHO danger sign in a child** (red) | counts against those conditions; next question |
| 4 | Does it hurt to bend your neck forward? | may fire **Headache or fever with stiff neck (possible meningitis)** (red) | counts against those conditions; next question |
| 5 | Do you get chills or shivering, and then break into a sweat? | evidence for the conditions below | counts against those conditions; next question |
| 6 | Have you had many mosquito bites lately, or do you sleep without a mosquito net? | evidence for the conditions below | counts against those conditions; next question |
| 7 | Is there a rash or red spots on the skin? | evidence for the conditions below | counts against those conditions; next question |
| 8 | Are the eyes or skin yellow? | evidence for the conditions below | counts against those conditions; next question |
| 9 | *Test: Palm check* — "Please hold both hands open toward the camera, palms facing me." | the camera judges the sign it looks for; a clear sign counts like a yes | counts against the conditions that need it |
| 10 | Do you vomit everything you eat or drink? | may fire **WHO danger sign in a child** (red) | counts against those conditions; next question |

Jev then chooses between: **Severe malaria** (red): Fever (often with chills, mosquito bites or no bed net) plus convulsions, very sleepy, cannot drink, yellow eyes or very pale; **Meningitis** (red): Fever with stiff neck, severe headache, rash or confusion; **Malaria** (yellow): Fever with chills and sweats, often after many mosquito bites or sleeping without a net, in a malaria area, without danger signs; **Dengue** (yellow): Fever with rash, body and eye pain, in a dengue area; **Fever from another infection** (yellow): The fever goes with a cough, a chest or urine problem, or an illness lasting weeks (TB): test for malaria, but the cause is elsewhere; **Viral fever** (green): Fever with no danger signs and no specific pattern

### If they say: diarrhea, vomits everything, belly pain  →  **Diarrhea / vomiting** opens

| order | question asked | a YES does | a NO does |
|---|---|---|---|
| 1 | Can you drink fluids, or are you unable to keep anything down? | may fire **WHO danger sign in a child** (red) | counts against those conditions; next question |
| 2 | Have you been unusually sleepy, or hard to wake up? | may fire **WHO danger sign in a child** (red) | counts against those conditions; next question |
| 3 | Are the eyes sunken, or are they very thirsty? | may fire **Diarrhea with dehydration signs** (yellow) | counts against those conditions; next question |
| 4 | Is there blood in the stool? | may fire **Blood in stool** (yellow) | counts against those conditions; next question |
| 5 | Do you vomit everything you eat or drink? | may fire **WHO danger sign in a child** (red) | counts against those conditions; next question |
| 6 | Is there diarrhea? | may fire **Diarrhea with dehydration signs** (yellow) | counts against those conditions; next question |
| 7 | Do you have a fever, or feel hot? | may fire **Headache or fever with stiff neck (possible meningitis)** (red); may fire **Back pain with fever (possible kidney infection)** (yellow); may fire **Fever: test for malaria** (yellow) | counts against those conditions; next question |
| 8 | *Test: Foot swelling check* — "Please press your thumb on the top of each foot for three seconds, then show the feet to the camera." | the camera judges the sign it looks for; a clear sign counts like a yes | counts against the conditions that need it |

Jev then chooses between: **Severe dehydration** (red): Very sleepy, cannot drink, sunken eyes; **Some dehydration** (yellow): Sunken eyes or very thirsty, still drinking; **Dysentery** (yellow): Blood in the stool; **Diarrhea without dehydration** (green): Loose stools, drinking normally, alert

### If they say: pregnant  →  **Pregnancy** opens

| order | question asked | a YES does | a NO does |
|---|---|---|---|
| 1 | Is there heavy bleeding that won't stop? | may fire **Severe bleeding** (red); may fire **Heavy bleeding in pregnancy** (red); may fire **Wound that needs cleaning, closing and tetanus cover** (yellow) | counts against those conditions; next question |
| 2 | Do you have a very strong headache or blurry vision? | may fire **Pregnancy danger sign (possible pre-eclampsia)** (red); may fire **Possible stroke: sudden loss of balance** (red) | counts against those conditions; next question |
| 3 | Has there been a seizure or shaking fit? | may fire **WHO danger sign in a child** (red); may fire **Seizure** (red) | counts against those conditions; next question |
| 4 | *Test: Foot swelling check* — "Please press your thumb on the top of each foot for three seconds, then show the feet to the camera." | the camera judges the sign it looks for; a clear sign counts like a yes | counts against the conditions that need it |
| 5 | Do you have a fever, or feel hot? | may fire **Headache or fever with stiff neck (possible meningitis)** (red); may fire **Back pain with fever (possible kidney infection)** (yellow); may fire **Fever: test for malaria** (yellow) | counts against those conditions; next question |

Jev then chooses between: **Bleeding in pregnancy** (red): Heavy vaginal bleeding; **Pre-eclampsia** (red): Severe headache, blurred vision, swelling or fits in pregnancy; **Infection in pregnancy** (yellow): Fever in pregnancy; **Routine pregnancy concern** (green): No danger signs

### If they say: injury, heavy bleeding  →  **Injury / bleeding** opens

| order | question asked | a YES does | a NO does |
|---|---|---|---|
| 1 | Is there heavy bleeding that won't stop? | may fire **Severe bleeding** (red); may fire **Heavy bleeding in pregnancy** (red); may fire **Wound that needs cleaning, closing and tetanus cover** (yellow) | counts against those conditions; next question |
| 2 | Does the arm or leg look bent, out of shape or very swollen? | may fire **Possible broken bone: limb bent, very swollen or cannot bear weight** (yellow) | counts against those conditions; next question |
| 3 | Can you put weight on it or move it normally, or not at all? | may fire **Possible broken bone: limb bent, very swollen or cannot bear weight** (yellow) | counts against those conditions; next question |
| 4 | Is the cut deep or wide, or does it gape open when you move? | may fire **Wound that needs cleaning, closing and tetanus cover** (yellow) | counts against those conditions; next question |
| 5 | Was it a dirty or rusty object, or an animal bite? | may fire **Wound that needs cleaning, closing and tetanus cover** (yellow) | counts against those conditions; next question |
| 6 | Have you had a tetanus shot in the last five years? | may fire **Wound that needs cleaning, closing and tetanus cover** (yellow) | counts against those conditions; next question |

Jev then chooses between: **Major bleeding** (red): Bleeding that will not stop, or a large wound; **Possible fracture** (yellow): After a fall or blow the limb looks bent or very swollen, or cannot bear weight or move; **Wound needing care** (yellow): A cut from a blade or tool, deep, gaping or dirty, that needs cleaning, closing and tetanus protection; **Minor injury** (green): Small cut or bruise

### If they say: headache, sudden, worst-ever headache  →  **Headache** opens

| order | question asked | a YES does | a NO does |
|---|---|---|---|
| 1 | Did the headache start suddenly, like a blow, and is it the worst you have ever had? | may fire **Sudden worst-ever headache (possible bleeding in the brain)** (red) | counts against those conditions; next question |
| 2 | Do you have a fever, or feel hot? | may fire **Headache or fever with stiff neck (possible meningitis)** (red); may fire **Back pain with fever (possible kidney infection)** (yellow); may fire **Fever: test for malaria** (yellow) | counts against those conditions; next question |
| 3 | Does it hurt to bend your neck forward? | may fire **Headache or fever with stiff neck (possible meningitis)** (red) | counts against those conditions; next question |
| 4 | Do you get chills or shivering, and then break into a sweat? | evidence for the conditions below | counts against those conditions; next question |
| 5 | Have you had many mosquito bites lately, or do you sleep without a mosquito net? | evidence for the conditions below | counts against those conditions; next question |
| 6 | Is one side of your face or one arm weak or numb? | evidence for the conditions below | counts against those conditions; next question |
| 7 | Does light or noise make it worse? | evidence for the conditions below | counts against those conditions; next question |
| 8 | Do you have a very strong headache or blurry vision? | may fire **Pregnancy danger sign (possible pre-eclampsia)** (red); may fire **Possible stroke: sudden loss of balance** (red) | counts against those conditions; next question |
| 9 | Are you pregnant? | may fire **Heavy bleeding in pregnancy** (red); may fire **Pregnancy danger sign (possible pre-eclampsia)** (red) | counts against those conditions; next question |

Jev then chooses between: **Bleeding in the brain** (red): Sudden, worst-ever headache, maybe with vomiting or confusion; **Meningitis** (red): Headache with fever and stiff neck, maybe rash or confusion; **High blood pressure** (yellow): Headache with blurred vision, older age or known high pressure; **Fever headache (malaria or infection)** (yellow): Headache with fever, no stiff neck; **Migraine** (green): Throbbing headache, light hurts, maybe nausea, has happened before; **Tension headache** (green): Pressing headache from stress, tiredness or not eating, no danger signs

### If they say: back pain, pain when bending, leg weakness / hard to stand  →  **Back / joint pain** opens

| order | question asked | a YES does | a NO does |
|---|---|---|---|
| 1 | Have you lost control of your bladder or bowels? | may fire **Back pain with leg weakness or loss of bladder control** (red) | counts against those conditions; next question |
| 2 | Are your legs weak, or is it hard to stand up? | may fire **Back pain with leg weakness or loss of bladder control** (red) | counts against those conditions; next question |
| 3 | *Test: Crouch and stand* — "Please crouch down slowly, then stand back up." | the camera judges the sign it looks for; a clear sign counts like a yes | counts against the conditions that need it |
| 4 | *Test: Forward bend* — "Please bend forward slowly, as if to touch your toes, then stand up." | the camera judges the sign it looks for; a clear sign counts like a yes | counts against the conditions that need it |
| 5 | Did that hurt when you bent over? | evidence for the conditions below | counts against those conditions; next question |
| 6 | Do you have a fever, or feel hot? | may fire **Headache or fever with stiff neck (possible meningitis)** (red); may fire **Back pain with fever (possible kidney infection)** (yellow); may fire **Fever: test for malaria** (yellow) | counts against those conditions; next question |
| 7 | Were you hurt in an accident or a fall? | may fire **Possible broken bone: limb bent, very swollen or cannot bear weight** (yellow); may fire **Wound that needs cleaning, closing and tetanus cover** (yellow) | counts against those conditions; next question |

Jev then chooses between: **Spinal cord compression** (red): Back pain with leg weakness or loss of bladder/bowel control; **Kidney infection** (yellow): Back or side pain with fever; **Sciatica / nerve pain** (yellow): Pain shooting down one leg, worse on bending; **Possible fracture** (yellow): Pain after a fall, cannot bear weight; **Muscle strain** (green): Back pain after lifting or work, moves normally

### If they say: feeling down or hopeless, little interest or pleasure, nervous or on edge, can't stop worrying, thoughts of ending their life, recent loss, violence or hardship, lonely or isolated  →  **Mental health** opens

| order | question asked | a YES does | a NO does |
|---|---|---|---|
| 1 | In the last two weeks, have you felt down, sad or hopeless on most days? | may fire **Positive depression or anxiety screen (PHQ-2 / GAD-2)** (yellow) | counts against those conditions; next question |
| 2 | In the last two weeks, have you had little interest or pleasure in doing things? | may fire **Positive depression or anxiety screen (PHQ-2 / GAD-2)** (yellow) | counts against those conditions; next question |
| 3 | Sometimes when people feel this way, they think about ending their life. Have you had thoughts like that? | may fire **Thoughts of suicide or self-harm** (red) | counts against those conditions; next question |
| 4 | Have you felt nervous, anxious or on edge on most days? | may fire **Positive depression or anxiety screen (PHQ-2 / GAD-2)** (yellow) | counts against those conditions; next question |
| 5 | Have you been unable to stop or control worrying? | may fire **Positive depression or anxiety screen (PHQ-2 / GAD-2)** (yellow) | counts against those conditions; next question |
| 6 | Has something very hard happened recently, like a loss or violence? | evidence for the conditions below | counts against those conditions; next question |
| 7 | How often do you feel alone, left out, or without people to talk to? | evidence for the conditions below | counts against those conditions; next question |
| 8 | There are people near you who meet regularly to talk and support each other, with a trained counselor. Would you like the health worker to introduce you? | evidence for the conditions below | counts against those conditions; next question |

Jev then chooses between: **Suicide risk** (red): Thoughts of ending their life or self-harm; **Depression** (yellow): Low mood or loss of interest on most days for two weeks or more; **Anxiety** (yellow): Nervous, on edge, cannot stop worrying on most days; **Stress or grief reaction** (green): Distress after a recent loss, violence or hardship; **Loneliness** (green): Feels alone or cut off from people, without low mood most days

### Safety rules and the exact answers that fire them

| rule | fires when | colour |
|---|---|---|
| Possible stroke: patient reports one-sided face or arm weakness | weakness_reported | red |
| Possible stroke: garbled speech test plus another stroke sign | unsteady / loss of balance, slurred or confused speech, started suddenly, weakness_reported | red |
| Possible heart attack: chest pain with warning signs | chest pain or pressure, pain spreads to arm, jaw or back, short of breath, sweating or clammy | red |
| WHO danger sign in a child | seizure / convulsions, cannot drink or breastfeed, very sleepy or hard to wake, vomits everything | red |
| Seizure | seizure / convulsions | red |
| Severe pneumonia sign: chest indrawing | blue lips, chest indrawing | red |
| Severe bleeding | heavy bleeding | red |
| Heavy bleeding in pregnancy | pregnant, heavy bleeding | red |
| Pregnancy danger sign (possible pre-eclampsia) | pregnant, severe headache or blurred vision | red |
| Sudden worst-ever headache (possible bleeding in the brain) | sudden, worst-ever headache | red |
| Headache or fever with stiff neck (possible meningitis) | fever, headache, stiff neck | red |
| Thoughts of suicide or self-harm | thoughts of ending their life | red |
| Possible stroke: sudden loss of balance | unsteady / loss of balance, slurred or confused speech, severe headache or blurred vision, started suddenly, weakness_reported | red |
| Back pain with leg weakness or loss of bladder control | back pain, lost bladder or bowel control, leg weakness / hard to stand | red |
| Swelling of both feet in a child (severe malnutrition sign) | swelling of both feet | red |
| Back pain with fever (possible kidney infection) | back pain, fever | yellow |
| Positive depression or anxiety screen (PHQ-2 / GAD-2) | nervous or on edge, can't stop worrying, little interest or pleasure, feeling down or hopeless | yellow |
| Possible pneumonia: cough with fast breathing | cough, fast breathing | yellow |
| Fever: test for malaria | fever | yellow |
| Diarrhea with dehydration signs | diarrhea, sunken eyes / very thirsty | yellow |
| Blood in stool | blood in stool | yellow |
| Possible broken bone: limb bent, very swollen or cannot bear weight | cannot use the limb, limb bent or very swollen, injury | yellow |
| Wound that needs cleaning, closing and tetanus cover | deep or gaping wound, dirty wound / bite, injury, heavy bleeding, tetanus shot in last 5 years | yellow |

## 3. What the camera sees and what it triggers

Jev is asked one yes/no per sign over the last two seconds of pictures (8 frames, plus a face close-up). Face/skin/eye signs need a close, lit, facing face; posture signs only need the body in view. A sign at **60%+** (face droop 45%+) becomes a hunch and is handled in two steps: first the sign is confirmed in the patient's own words; if they agree, the cause question follows; if they say no, it is dropped and never counts.

| the camera sees | at 60%+ the pod says | then asks (step 1: confirm the sign) | if yes, asks (step 2: the cause) | and if that is yes |
|---|---|---|---|---|
| One side of face drooping | "I notice one side of your face looks a little different." | Is one side of your face or one arm weak or numb? | Is one side of your face or one arm weak or numb? | **Stroke / brain** opens: face or arm weakness… |
| Eyes looking to one side | "(no remark: counted as a sign only)" | — | Is one side of your face or one arm weak or numb? | **Stroke / brain** opens: face or arm weakness… |
| Looks confused or disoriented | "(no remark: counted as a sign only)" | — | Is one side of your face or one arm weak or numb? | **Stroke / brain** opens: face or arm weakness… |
| Mouth hanging open / drooling | "(no remark: counted as a sign only)" | — | Is one side of your face or one arm weak or numb? | **Stroke / brain** opens: face or arm weakness… |
| Shaking or trembling | "I notice you are shaking a little." | Do you get chills or shivering, and then break into a sweat? | Do you have a fever, or feel hot? | **Fever** opens: very sleepy or hard to wake, seizure / convulsions, cannot drink or breastfeed… |
| Jerking movements | "(no remark: counted as a sign only)" | Has there been a seizure or shaking fit? | Do you have a fever, or feel hot? | **Fever** opens: very sleepy or hard to wake, seizure / convulsions, cannot drink or breastfeed… |
| Yellow eyes | "Your eyes look a little yellow." | Are the eyes or skin yellow? | Do you have a fever, or feel hot? | **Fever** opens: very sleepy or hard to wake, seizure / convulsions, cannot drink or breastfeed… |
| Red eyes | "Your eyes look a little red." | Do you have a fever, or feel hot? | Do you have a fever, or feel hot? | **Fever** opens: very sleepy or hard to wake, seizure / convulsions, cannot drink or breastfeed… |
| Sunken eyes | "(no remark: counted as a sign only)" | Are the eyes sunken, or are they very thirsty? | Is there diarrhea? | **Diarrhea / vomiting** opens: cannot drink or breastfeed, very sleepy or hard to wake, sunken eyes / very thirsty… |
| Tearful or crying | "You seem upset, and that's okay." | In the last two weeks, have you felt down, sad or hopeless on most days? | In the last two weeks, have you felt down, sad or hopeless on most days? | **Mental health** opens: feeling down or hopeless, little interest or pleasure, thoughts of ending their life… |
| Eyes keep closing | "(no remark: counted as a sign only)" | Have you been unusually sleepy, or hard to wake up? | Do you have a fever, or feel hot? | **Fever** opens: very sleepy or hard to wake, seizure / convulsions, cannot drink or breastfeed… |
| Very pale | "You look a bit pale." | Have you been very pale or tired lately? | — | — |
| Flushed, red face | "Your face looks a little red." | Do you have a fever, or feel hot? | Do you have a fever, or feel hot? | **Fever** opens: very sleepy or hard to wake, seizure / convulsions, cannot drink or breastfeed… |
| Sweaty or clammy | "I notice you are sweating." | Are you sweating a lot right now, or breaking into a cold sweat, even without heat or hard work? | Do you have pain or pressure in your chest? | **Chest pain / heart** opens: pain spreads to arm, jaw or back, sweating or clammy, short of breath… |
| Blue or grey lips | "(no remark: counted as a sign only)" | Are the lips or fingertips turning blue? | — | — |
| Yellow skin | "(no remark: counted as a sign only)" | Are the eyes or skin yellow? | Do you have a fever, or feel hot? | **Fever** opens: very sleepy or hard to wake, seizure / convulsions, cannot drink or breastfeed… |
| Rash or red spots | "I see some spots on your skin." | Is there a rash or red spots on the skin? | Do you have a fever, or feel hot? | **Fever** opens: very sleepy or hard to wake, seizure / convulsions, cannot drink or breastfeed… |
| Insect bite marks | "I see some bite marks on your skin." | Have you had many mosquito bites lately, or do you sleep without a mosquito net? | Do you have a fever, or feel hot? | **Fever** opens: very sleepy or hard to wake, seizure / convulsions, cannot drink or breastfeed… |
| Bruises | "(no remark: counted as a sign only)" | Were you hurt in an accident or a fall? | Were you hurt in an accident or a fall? | **Injury / bleeding** opens: heavy bleeding, limb bent or very swollen, cannot use the limb… |
| Cut or open wound | "I see a wound." | Were you hurt in an accident or a fall? | Were you hurt in an accident or a fall? | **Injury / bleeding** opens: heavy bleeding, limb bent or very swollen, cannot use the limb… |
| Active bleeding | "(no remark: counted as a sign only)" | Is there heavy bleeding that won't stop? | Are you pregnant? | **Pregnancy** opens: heavy bleeding, severe headache or blurred vision, seizure / convulsions… |
| Burn | "(no remark: counted as a sign only)" | Were you hurt in an accident or a fall? | Were you hurt in an accident or a fall? | **Injury / bleeding** opens: heavy bleeding, limb bent or very swollen, cannot use the limb… |
| Dry, cracked lips | "(no remark: counted as a sign only)" | — | Is there diarrhea? | **Diarrhea / vomiting** opens: cannot drink or breastfeed, very sleepy or hard to wake, sunken eyes / very thirsty… |
| Struggling to breathe | "It looks a little hard for you to breathe." | Is it hard to breathe right now? | Do you have pain or pressure in your chest? | **Chest pain / heart** opens: pain spreads to arm, jaw or back, sweating or clammy, short of breath… |
| Breathing through the mouth | "I notice you are breathing through your mouth." | Is it hard to breathe right now? | Do you have a cough? | **Breathing / cough** opens: chest indrawing, cannot drink or breastfeed… |
| Nostrils flaring | "(no remark: counted as a sign only)" | Is it hard to breathe right now? | Do you have pain or pressure in your chest? | **Chest pain / heart** opens: pain spreads to arm, jaw or back, sweating or clammy, short of breath… |
| Chest moving fast | "(no remark: counted as a sign only)" | Is the breathing faster than normal? | Do you have a cough? | **Breathing / cough** opens: chest indrawing, cannot drink or breastfeed… |
| Coughing | "I heard you cough." | Do you have a cough? | Do you have a cough? | **Breathing / cough** opens: chest indrawing, cannot drink or breastfeed… |
| Runny nose or sneezing | "(no remark: counted as a sign only)" | — | Do you have a cough? | **Breathing / cough** opens: chest indrawing, cannot drink or breastfeed… |
| Holding the chest | "I see you holding your chest." | Do you have pain or pressure in your chest? | Do you have pain or pressure in your chest? | **Chest pain / heart** opens: pain spreads to arm, jaw or back, sweating or clammy, short of breath… |
| Holding the head | "I see you holding your head." | Do you have a headache? | Is one side of your face or one arm weak or numb? | **Stroke / brain** opens: face or arm weakness… |
| Holding the belly | "I see you holding your belly." | Do you have pain in your belly? | Is there diarrhea? | **Diarrhea / vomiting** opens: cannot drink or breastfeed, very sleepy or hard to wake, sunken eyes / very thirsty… |
| Holding the back | "I see you holding your back." | Do you have pain in your back? | Do you have pain in your back? | **Back / joint pain** opens: lost bladder or bowel control, leg weakness / hard to stand… |
| Protecting an arm or leg | "(no remark: counted as a sign only)" | — | Were you hurt in an accident or a fall? | **Injury / bleeding** opens: heavy bleeding, limb bent or very swollen, cannot use the limb… |
| One arm hanging limp | "(no remark: counted as a sign only)" | Is one side of your face or one arm weak or numb? | Is one side of your face or one arm weak or numb? | **Stroke / brain** opens: face or arm weakness… |
| Slumped, can't sit up | "(no remark: counted as a sign only)" | Have you been unusually sleepy, or hard to wake up? | Do you have a fever, or feel hot? | **Fever** opens: very sleepy or hard to wake, seizure / convulsions, cannot drink or breastfeed… |
| Rocking or restless | "(no remark: counted as a sign only)" | — | In the last two weeks, have you felt down, sad or hopeless on most days? | **Mental health** opens: feeling down or hopeless, little interest or pleasure, thoughts of ending their life… |
| Sad expression | "You seem a little down." | In the last two weeks, have you felt down, sad or hopeless on most days? | In the last two weeks, have you felt down, sad or hopeless on most days? | **Mental health** opens: feeling down or hopeless, little interest or pleasure, thoughts of ending their life… |
| Anxious or frightened | "You seem a little worried." | Have you felt nervous, anxious or on edge on most days? | In the last two weeks, have you felt down, sad or hopeless on most days? | **Mental health** opens: feeling down or hopeless, little interest or pleasure, thoughts of ending their life… |
| Flat, no expression | "(no remark: counted as a sign only)" | — | In the last two weeks, have you felt down, sad or hopeless on most days? | **Mental health** opens: feeling down or hopeless, little interest or pleasure, thoughts of ending their life… |
| Drowsy or limp | "You look very sleepy." | Have you been unusually sleepy, or hard to wake up? | Do you have a fever, or feel hot? | **Fever** opens: very sleepy or hard to wake, seizure / convulsions, cannot drink or breastfeed… |
| Very thin / wasted | "(no remark: counted as a sign only)" | Has there been a lot of weight loss? | — | — |
| Hollow cheeks | "(no remark: counted as a sign only)" | Has there been a lot of weight loss? | — | — |
| Puffy, swollen face | "(no remark: counted as a sign only)" | — | Is there diarrhea? | **Diarrhea / vomiting** opens: cannot drink or breastfeed, very sleepy or hard to wake, sunken eyes / very thirsty… |
| Visibly pregnant | "(no remark: counted as a sign only)" | Are you pregnant? | Are you pregnant? | **Pregnancy** opens: heavy bleeding, severe headache or blurred vision, seizure / convulsions… |
| Using a cane or crutch | "(no remark: counted as a sign only)" | — | Do you have pain in your back? | **Back / joint pain** opens: lost bladder or bowel control, leg weakness / hard to stand… |
| Already bandaged | "(no remark: counted as a sign only)" | Were you hurt in an accident or a fall? | Were you hurt in an accident or a fall? | **Injury / bleeding** opens: heavy bleeding, limb bent or very swollen, cannot use the limb… |
| Wearing a face mask | "(no remark: counted as a sign only)" | — | Do you have a cough? | **Breathing / cough** opens: chest indrawing, cannot drink or breastfeed… |

Signs with no question of their own (drooping eyelid, discharge from eyes, bruises, blisters, a bandage, a cane) are shown to the health worker as "camera noticed, worth asking about".

### Joint tracking for physical tests (next step: YOLO26-pose)

Today the physical tests (smile, arm drift, heel-to-toe walk, crouch, bend forward, chest indrawing, palms, feet) are judged by Jev looking at a few seconds of pictures. The upgrade is to run **YOLO26-pose** in the browser or on the pod: it returns 17 body keypoints per person (nose, eyes, ears, shoulders, elbows, wrists, hips, knees, ankles) at camera speed, NMS-free, with better keypoint accuracy than YOLO11 (vendor figure: up to +7.2 AP on COCO pose). That turns each test into a measurement instead of an impression:

| test | ask the patient to | measure from keypoints | what it suggests |
|---|---|---|---|
| Arm drift (stroke) | hold both arms out, eyes closed, 10 s | wrist height difference over time; one wrist falling > 10% of arm length | one-sided weakness → stroke rule with the smile test |
| Bend forward (back) | bend to touch toes, slowly | hip-to-shoulder angle at full bend; speed; asymmetry; guarding (stops early) | sciatica / strain vs. a fracture that cannot bend |
| Crouch and stand (legs, hips) | crouch, stand back up | knee angle reached; time to stand; using hands | leg weakness, hip/knee injury |
| Heel-to-toe walk (balance) | 6 steps along a line | ankle path straightness, step length variability, sway of the shoulder line | balance loss → stroke (BE-FAST) or dehydration |
| Raise both arms (shoulder, fracture) | lift both arms overhead | max shoulder angle each side; difference | shoulder or arm injury, cannot raise = fracture or dislocation |
| Turn the head, bend the neck | chin to chest | nose-to-shoulder-line distance | stiff neck (meningitis) when they cannot |
| Breathing rate (chest) | sit still 20 s | vertical oscillation of the shoulder keypoints | fast breathing without touching the patient |
| Gait after injury | walk 4 steps | asymmetric step time, dropped hip, foot not planted | cannot bear weight → possible fracture |

Rules for using it: compare the two sides of the same body, never against a population norm; ask for three repetitions and keep the median; the camera at eye level, the whole body in frame for walks; and every pose measurement is a *question prompt* for the patient and the health worker, never a diagnosis by itself.

### How the probability is formed (the nurse's "how worried am I")

- Rules first: one firing red rule = emergency, whatever else is true.
- For each open area Jev picks the most likely of its conditions given everything said and seen (plus "not sure yet"). That pick × how strongly the area opened × how many of its questions were answered gives the probability.
- A condition is named only at >= 70% with two separate findings (one finding is enough for a benign condition once three danger questions were answered no). Below that it stays "possible" on the staff screen with its for/against evidence, and the pod says it is not settled.
- Colour: red from rules, yellow when a named condition needs treatment or a doctor today, green otherwise.
