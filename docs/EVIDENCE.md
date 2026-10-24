# Why this works: the evidence behind Triage Pod

Numbers and papers behind each part of the project, with where they come from. Collected 24 Oct 2026. Secondary sources are marked; check the primary paper before putting a number on a slide.

## 1. The problem: medicine exists, distribution fails

- **Zambia, 145 facilities (2009–2010):** up to **30% of surveyed facilities stocked out of artemether-lumefantrine (the first-line malaria drug) in a quarter, while ample inventory sat at the national warehouse.** The cause was inventory policy, not supply. Leung et al., *PLOS ONE* 2016, secondary analysis of a field experiment in Zambia. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4882057/
- Zambia created the Access-to-ACT Initiative specifically to cut stock-out rates of ACTs and rapid tests at health centres (World Bank DIME brief). https://documents1.worldbank.org/curated/en/674561468180864845/pdf/757370BRI0P113060180120Zambia0FINAL.pdf
- **Zambia today (World Bank, pulled live by the /deploy page):** 21.9 million people (2025), 54% rural, **0.32 doctors per 1,000 people** (2022), **48 under-five deaths per 1,000 births** (2024), **252 malaria cases per 1,000 people at risk per year** (2024). For comparison the US has about 3.6 doctors per 1,000.

## 2. Drones to the last mile: the outcome evidence

- **Rwanda, University of Pennsylvania study of Zipline's network:** **in-hospital maternal deaths fell by about 51%** at hospitals served by drone blood delivery; every adopting hospital held less blood inventory, and the facilities closest to drone ports saw the largest reductions. Published in *Manufacturing & Service Operations Management*; summaries: https://mobile.hospimedica.com/critical-care/articles/294811654/medical-drone-program-improves-blood-access-and-patient-survival.amp.html and https://www.zipline.com/newsroom/journal-article-last-mile-delivery-reduces-maternal-mortality-by-51
- A February 2026 retrospective follow-up reports **postpartum haemorrhage deaths down 46%** (secondary summary): https://wyde.beehiiv.com/p/zipline-hits-7-6-billion-valuation-and-2-million-deliveries-as-rwanda-goes-nationwide
- Ghana replication reported by Zipline: about 56% (company figure, not peer-reviewed). Zipline flies in Rwanda, Ghana, Nigeria, Kenya and Côte d'Ivoire; I could not confirm a Zambia programme (checked 24 Oct 2026), so the map's drones stand for a partner to sign, not a fleet that exists today. Zipline's 2026 US State Department deal funds expansion to 15,000 facilities across Africa, so the partner is realistic.

## 3. Where a nurse-style assessment is missing, children die of missed danger signs

- **Malawi, community Health Surveillance Assistants:** about **18% of children presented with danger signs**; HSAs **correctly assessed only 37%** of children for the four danger signs and **referred only 55%** of those who had them. Gilroy et al., *Health Policy and Planning* 2013. https://pmc.ncbi.nlm.nih.gov/articles/PMC3753880
- After IMCI introduction, referral rates for children ran at 6–20%, and successful referral (arriving at the facility) has been documented as low as **28%** (cited in BMJ Open 2023). https://archive.lstmed.ac.uk/24458/1/bmjopen-2023-079589.pdf
- WHO's IMCI algorithm (danger signs first, then main symptoms, then classify) is the backbone of the pod's child flow. Overview: https://pmc.ncbi.nlm.nih.gov/articles/PMC2486998

This is the gap the pod fills: it never skips the danger-sign questions, and a danger sign both calls for help and orders the pre-referral treatment on the spot.

## 4. Can an AI triage safely? What the studies say

- **UCSF, JAMA Network Open, May 2024 (large retrospective ED set):** GPT-4 judged clinical acuity correctly in **89%** of case pairs; on a 500-case subset it scored 88% against a clinician's 86%. Summary: https://dev-hlm.wtwhmedia.com/node/90737
- **Turkey, 2024, 100 ESI vignettes:** GPT-4 correct triage 70.6% overall and **about 85% on the critical ESI 1–2 cases**, versus 49% for the emergency specialists in that set; the physicians under-triaged 32.9%. https://avesis.bozok.edu.tr/yayin/b1561c28-751b-437a-bc52-309954fd5387/comparative-analysis-of-chatgpt-gemini-and-emergency-medicine-specialist-in-esi-triage-assessment
- **Swiss cohort, Scientific Reports, Sept 2024:** agreement with an expert panel 76.6% overall, and **kappa 0.83 for high-acuity (ESI 1–2)** patients. https://doaj.org/article/023c66b052ba49c3a44bd0bf769b7fa1
- **Thailand 2025, n = 387, voice input in Thai:** ChatGPT-4o over-triaged 2.6% and under-triaged 3.4%, while nurses over-triaged 23.3%. https://he02.tci-thaijo.org/index.php/TJEM/article/view/277102
- **Israel, Journal of Clinical Nursing:** GPT-4 tended to over-triage (median ESI 2 vs 3 for humans), a reason to keep hard rules and a human in the loop. https://cris.haifa.ac.il/en/publications/evaluating-large-language-model-assisted-emergency-triage-a-compa/
- A 2026 review concludes the evidence is still fragile and these tools belong in decision support, not replacement: https://link.springer.com/article/10.1186/s12873-026-01521-y
- Older symptom checkers (Semigran 2015, 23 apps, 45 vignettes) gave the right first diagnosis only about a third of the time and correct triage advice about 57% of the time. Benchmark reused in a 2026 preprint: https://www.medrxiv.org/content/10.64898/2026.09.01.26361908

What this means for the design: models are strongest exactly where it matters most (the critical cases), weakest on the middle. So the pod keeps **safety rules in code** that override the model, names a condition only with strong evidence, and sends a health worker to check every "uncertain" case the same day.

## 5. Mental health through neighbours, not clinics

- **Friendship Bench, Zimbabwe, cluster-randomised trial, JAMA 2016 (Chibanda et al., DOI 10.1001/jama.2016.19102):** problem-solving therapy delivered by **lay community volunteers on a bench** cut depression symptoms at six months to **14% versus 50%** with usual care. https://www.lshtm.ac.uk/newsevents/news/2016/friendship_bench_therapy_reduced_anxiety_depression.html
- Since scaled to Malawi, Zanzibar and New York City. https://www.centreforglobalmentalhealth.org/research-projects/the-friendship-bench/

The pod's community circles copy this exactly: it screens with the two PHQ-2 questions, pairs a person with a trained volunteer from their own village, and invites every adult to volunteer at the end of a visit.

## 6. Voice in the patient's language

- Cartesia speech models (Sonic-3 / Ink-Whisper) cover 42 languages with regional accents; the pod transcribes both candidate languages at once and lets Jev pick, keeps the region's language as the prior, and mirrors the community's own words (dialect memory per village). No African languages yet, which is the honest limit: in Eastern Province the pod speaks English today; Chewa/Nyanja is the next voice to add.

## 7. Satellite data as an input (built: `/api/satellite`)

- **NASA POWER** (free, no key) serves satellite-derived daily rainfall (GPM) and temperature (MERRA-2) for any point on Earth. The pod pulls the last 30 days for all 40 posts (one request per 0.5° × 0.625° grid cell, 18 cells): 80 mm+ of rain in a month with 18–32 °C nights is the malaria transmission window two to six weeks later; a 40 mm day marks likely flooding. Docs: https://power.larc.nasa.gov/docs/services/api/
- Caveat, checked 24 Oct 2026: POWER's most recent weeks come from the preliminary GPM run and this season read hundreds of millimetres where the finished record for the same weeks in 2025 reads 0.3 mm (dry season). The API therefore also fetches the same window one year earlier and the government view shows both; single day-values above 150 mm are left out of totals and counted in the source line.
- **Forecast, rivers and flood-now (built 24 Oct 2026: `/api/weather/outlook`, `/api/weather/road`, overlay on `/api/satellite`; see `docs/WEATHER.md`).** Three further free, keyless sources, each verified live from the venue: **Open-Meteo** (ECMWF/GFS best match, ~11 km) gives 16 days of daily rain, rain probability and temperature ahead and 30 days behind at same-day latency, https://open-meteo.com/en/docs; **Copernicus GloFAS v4** river discharge (5 km) through Open-Meteo's flood API, a year of history plus 16 days ahead, so a river "forecast above last year's 95th percentile" can be flagged per cell, https://open-meteo.com/en/docs/flood-api (direct Copernicus access needs an ECMWF login); **NASA LANCE MODIS/VIIRS near-real-time flood map** (MCDWD 3-day composite, 250 m) read as a picture from GIBS, https://www.earthdata.nasa.gov/data/instruments/modis/near-real-time-data/modis-nrt-global-flood-product (the raw files need an Earthdata login; `NASA_EARTHDATA_TOKEN` is the hook for later). From these every post gets `floodRiskToday`, `floodRisk14d`, "roads may close in N days", and a six-week malaria outlook (transmission follows rain by 4–8 weeks at 18–32 °C; Craig, Snow & le Sueur 1999, https://doi.org/10.1016/S0169-4758(99)01396-4), and every planned truck leg gets a risk from 3–5 points sampled along it.
- Caveat on the forecast layer: satellites give area flooding, not road passability (the flood map only sees water where the sky was clear, on 24 Oct 15–38% of the area around each post), rain beyond day 7 is model guidance, and the GloFAS cells here are small tributaries. The badges mean "ask before you send"; the dispatcher confirms with the district driver.
- Next inputs, all free: Sentinel-1 radar flood maps (roads cut → drone-only routing), Sentinel-2 water index (standing water → breeding sites), WorldPop and Google Open Buildings (where people actually live → where to put pods), VIIRS night lights (electrification for charging).

## 8. One-line stats for the pitch

- "In Zambia, 3 in 10 clinics ran out of malaria drugs while the warehouse was full." (PLOS ONE 2016)
- "Drone delivery cut maternal deaths by half in Rwanda." (Penn / MSOM)
- "Community workers referred only 55% of children with danger signs." (Health Policy & Planning 2013)
- "AI gets the critical cases right 85–89% of the time; the pod adds hard rules on top." (JAMA Netw Open 2024; ESI studies 2024)
- "A bench and a trained neighbour cut depression from 50% to 14%." (JAMA 2016)
- "0.32 doctors per 1,000 people in Zambia." (World Bank 2022)
