# From hackathon to first real users

Research done 2026-10-24 (web sources linked; items marked **unverified** need a check before acting).
Live numbers for every candidate country are on the `/deploy` page of the app.

## 1. The biggest finding: language

Alta Verapaz (our demo region) is 69 % rural and **Q'eqchi' is the first language of ~67 %
of people; Spanish of only ~13 %** (2018 census, [citypopulation](https://www.citypopulation.de/en/guatemala/admin/16__alta_verapaz)).
A Spanish-only pod misses most patients there. Options, in order:

1. Pilot with the health worker interpreting (works now).
2. Pilot first in Spanish-dominant areas (eastern Guatemala, Honduras, Nicaragua) or in a
   French / Portuguese / English country the pod already speaks (see `/deploy`).
3. Build Q'eqchi' speech: record and transcribe with a partner, then fine-tune speech-to-text and
   use Cartesia voice cloning of a Q'eqchi' speaker.

## 2. Where to pilot first (Guatemala)

| Organisation | Why | Contact |
|---|---|---|
| **TulaSalud** (best fit) | Cobán HQ, works with the Ministry of Health in Alta Verapaz; already equips volunteer health workers with phones and telemedicine (Kawok app, 500k+ pregnancies registered); says it needs outside funding ([PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC4509884), [Dimagi](https://dimagi.com/2024-tulasalud-case-study), [tula.org](https://tula.org/news/calling-on-kawok-digital-health-solutions-guatemala)) | info@tula.org · [tula.org/contact](https://tula.org/contact) |
| **Wuqu' Kawoq / Maya Health Alliance** | Care in Mayan languages; ran an mHealth RCT; **has its own US-registered IRB**, which shortens ethics review | Contact@wuqukawoq.org · [mayahealth.org](https://mayahealth.org) |
| PIES de Occidente | Quetzaltenango, Indigenous community health since 1994 | contacto@piesdeoccidente.org.gt |
| Curamericas Guatemala | Huehuetenango, strong evaluation record | [curamericas.org](https://www.curamericas.org) |

Not options: Partners In Health has no Guatemala programme; Medical Teams International closed its Guatemala office.

Outside Latin America, groups already running digital health-worker tools: Malaria Consortium
upSCALE (Mozambique, Portuguese), Muso / DISC-Mali (French), PIH and Last Mile Health (Sierra
Leone and Liberia, English). PATH's silent-mode AI study in Rwanda is the design to copy.

## 3. Permissions (what a silent pilot needs first)

- A letter from the Área de Salud (Alta Verapaz health department, DASAV) and a partner agreement.
- One ethics committee approval (a Guatemalan university's, or Wuqu' Kawoq's IRB) plus your own
  university's IRB if students run research. Guatemala's clinical-trial rule (Acuerdo
  Ministerial 82-2019) needs ethics + regulator; a **silent observational** pilot that changes no
  care is probably not a trial (**unverified, confirm with the ministry**).
- Guatemala has **no general data-protection law** (bill 6464 still in committee, July 2026) — use
  written consent and keep data minimal anyway.
- WHO's 2024 guidance on large multimodal models warns about automation bias → run silent first.
- Filming: written permission from the facility director, consent from everyone on camera,
  parent consent for minors (better: staged scenes with consenting adults).

## 4. 90-day pilot plan

- **Days 0–30:** partner agreement, Área de Salud letter, ethics submission (observational,
  silent mode); test the pod on 200+ written IMCI cases; check power and mobile signal at 3–4 posts
  (Alta Verapaz has the country's lowest electricity coverage → budget solar + battery).
- **Days 30–75:** silent mode at 2–3 posts. Health worker triages as usual; the pod runs in
  parallel with its result hidden; a nurse/doctor sets the reference; remote doctor reviews reds.
  Target 250–400 visits.
- **Days 75–90:** analyse; interviews; decide on a visible-advice phase.
- **Measure:** under-triage of reds (main safety number), agreement with clinician (weighted
  kappa), referral accuracy, minutes per visit, uptime, Spanish fallback rate, acceptance (SUS),
  supply-forecast error. For 95 % ± 5 % sensitivity at 10 % red prevalence: ~73 red cases ≈ 730
  patients (Buderer method).

## 5. Making it closer to a real clinic visit (top 5 upgrades)

1. **Pulse oximeter with child probe** (~$13–50; ~$370 with breathing rate). Highest impact: in
   West Africa IMCI without oximetry referred only 25 % of children who later died
   ([PMC9789366](https://pmc.ncbi.nlm.nih.gov/articles/PMC9789366)). Bluetooth pulse-ox profile exists.
2. **Align the rules with ePOCT+ / WHO SMART child-health kit** (free). Trials in Tanzania and
   Rwanda cut antibiotic use from ~70 % to ~25 % with no worse recovery.
3. **Bluetooth thermometer, BP cuff, glucometer** (~$150 total). Standard Bluetooth profiles; Omron
   gives a free developer kit.
4. **Rapid tests read by the pod's camera** ($0.22–0.90 per test: malaria, HIV, syphilis, dengue).
   AI strip readers reach ~97 % accuracy (HealthPulse, Malaria Journal 2025). Turns a guess into a
   confirmed result.
5. **Haemoglobin meter + the validation study.** Palm pallor by eye catches only ~36 % of anaemia.

Known weak spots to be honest about: face-video heart rate errors rise on darker skin (≈5 → 14 bpm
for classic methods); camera blood-pressure failed in Nigeria; cough AI for TB is still research.

## 6. Money that fits right now

- **MIT Solve 2027 Global Health Challenge — deadline 6 Nov 2026**; prototypes eligible; ~$40k
  average, AI for Humanity prize up to $150k ([solve.mit.edu](https://solve.mit.edu/challenges/2027-global-health-challenge)).
- Watch: UNICEF Venture Fund (up to $100k equity-free; listed "AI-enabled triage tools" as an
  example), Grand Challenges Canada Stars (seed up to CAD 100k).

## 7. Filming the pod in use

- Hire through **Upwork / Workana / Twine** or a fixer on **journalist.net / paydesk.co**; most
  crews are in Guatemala City (bring them to Cobán). Upwork Guatemala filmmakers ~$16–25/hr;
  budget **$300–900 for a 1–2 day shoot** + travel (**estimate**).
- Ask **TulaSalud** for site access, and the Universidad Rafael Landívar Verapaz campus (Cobán) for
  students. Casa Comal runs a low-cost film school.
- Cheaper: the partner films on a phone with a gimbal + wireless lav (~$250–400 kit), directed
  live over WhatsApp.
- Job post (EN/ES) and shot list: see the research notes in this repo's history / ask Claude.

## 8. What is built for the pitch

- `/` pod: hands-free voice in local accents, live 60-trait camera scan, history-first questioning,
  guided physical tests, safety rules, strongly-supported conditions only.
- `/agents`: pods report to the network; outbreak sentinel, supply allocator, referral router and
  doctor queue act and talk back; Claude coordinator writes briefings. Pods change their questions
  when a nearby outbreak is flagged.
- `/dashboard`: satellite map, stock vs AI-triage forecast, drone/road allocation.
- `/deploy`: live World Bank statistics for 18 candidate countries, partners, impact calculator.
- `/registry`: consented patient records, needs by community, peer groups.
