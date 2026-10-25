## Inspiration

Zambia records up to 11 million malaria cases a year in a country of 22 million (Ministry of Health, 2023); WHO estimates 8,500 deaths, most of them never reaching a clinic. The medicine exists. In January 2025 the national distributor reported anti-malarials at 100% availability at the warehouse; the same year Zambia's own health plan put only 35% of primary clinics fully stocked. A 145-clinic study found three in ten clinics out of malaria drugs while the warehouse was full. Half of rural households are more than 5 km from any facility, and in the rainy season whole villages are cut off for weeks.

So the problem is not supply. It is that nobody at the village can say what is needed, and nothing moves it there before the roads close. I built Orbit Health to do both.

## What it does

**A pod in every village.** A box with a camera, a microphone, a speaker and a finger pulse-oximeter. The patient talks in their own language. The pod asks like a nurse: danger signs first, then history, then only the questions that matter for what it heard. It reads the camera for signs (a hand on the chest, a yellowed eye), names a condition only with strong evidence, and orders exactly what that condition needs, not a guess. It learns the village's words and, with consent, the village's voice.

**A live map.** Every order becomes a delivery in the patient's name, shipped from wherever the stock actually is (the post's shelf, a neighbouring post with surplus, or the Chipata hub) on one of Zambia's real carriers: ZAMMSA trucks, district pickups, community-health-worker motorbikes, bicycles, Luangwa boats. Drawn on the real road, on a globe of 23,206 villages found by counting 4.3 million roofs from satellite imagery.

**A distribution brain.** Satellites feed it: 16-day rain forecasts, Copernicus river-flood forecasts, NASA's three-day flood map read pixel by pixel around every road, ten years of daily rain per post (it knows Katete's roads usually close from 13 January), and the 4–8 week lag between rain and malaria. It ranks shipments (emergency, pod requests, pre-positioning before a closure, outbreak top-ups, routine), batches them into multi-stop truck runs, checks every leg for flooding and road surface, re-routes around blocked crossings, switches to a motorbike or boat when no road is dry, and re-checks every route every ten minutes.

**The crisis, measured.** A rainy-season week: 26 posts in need at once, 46 empty shelves, both Luangwa crossings under water, three vehicles down. In about thirty seconds the planner turns 841 orders into 83 vehicle movements instead of 833, has posts lend to posts, sends boats and motorbikes where roads are cut: 112,849 km and 2,044 driving hours saved against one trip per order. Every number comes from the live database.

Also: a mosquito listener (Oxford's HumBug wingbeat models) that names the species it hears and raises the village's malaria likelihood when the carrier is around; and Tracks, which proposes motorbike and bicycle routes from satellite terrain to villages with no road at all.

## How I built it

- **SpacetimeDB**: seventeen tables hold the whole province; the logic runs inside the database as reducers, one transaction each (one call writes the visit, picks the shelf, creates the orders); a scheduled reducer ticks every second and moves every delivery; every screen is a WebSocket subscription, so a route written by the planner is on every map in the same frame. The crisis is one reducer call.
- **Grok Voice (xAI)**: speech-to-text with the village's own words sent as key terms so dialect is kept, not corrected; text-to-speech streamed at 24 kHz with fixed sentences cached; custom voices cloned from a consenting patient's clips and stored per village, used before any catalog voice; grok-4-fast vision for a yes/no on sweat from one face close-up.
- **Jev (TypeSafe)**: every clinical decision: 96 findings scored from the transcript each turn, 61 camera traits per 8-frame burst, language pick. Thirty-second timeout; failures shown, never hidden.
- **Claude**: wording only: restating the complaint, phrasing open questions, closing advice, the handover note; second opinion on serious camera signs after three consistent bursts.
- **Satellites, all keyless**: NASA POWER, Open-Meteo (forecast + ten-year archive), Copernicus GloFAS and DEM, ESA WorldCover, Sentinel-2, NASA GIBS flood maps, Google Open Buildings, GeoNames, OpenStreetMap roads via OSRM.
- **Hardware**: Seeed XIAO nRF52840 + MAX30101 finger sensor, Grove Vision AI V2 camera, both over USB; firmware written and tested on the boards.
- **Next.js 15 / TypeScript**, 22 screens, 24 API routes; Python for the mosquito classifier (TensorFlow) and the terrain cost maps.

## Challenges

- **Making the pod stop asking.** Early versions asked forever or asked the wrong thing. Rebuilt around how a nurse works: what brought you in, open only the matching areas, a hard cap of seven steps, "nothing found" as a real outcome.
- **False alarms from the camera.** One lopsided frame behind a hand produced "is one side of your face drooping?". Now a serious sign must persist three bursts under even light, the smile test runs before any stroke question, and a second model looks at the same frames.
- **Satellite data that lies.** NASA's preliminary rainfall showed 450 mm in a dry-season week; it is cross-checked against last year's finished record and labelled preliminary on screen.
- **No drone fleet in Zambia.** Drones are labelled "proposed partner" and the planner only reaches for one when nothing on the ground can carry the load. Roads come from OpenStreetMap because the Overpass servers refused every query all night.
- **Speed.** A turn took sixteen seconds; it now takes about three: one mic stream per visit, streamed speech, cached fixed questions, wording drafted while Jev reads.

## What I learned

The hard part was never the model; it was deciding what the model is allowed to decide. The rapid test still decides malaria, the pod only moves the starting guess. A satellite can say an area is wet, not that a culvert is out, so the badge means "call the district driver". Every limit written on the screen made the product more believable, not less.

## What's next

Route the proposed terrain tracks inside the planner so a cut-off post is really served off-road; Chewa/Nyanja voices; a nurse's red pen on every verdict; a second province; a real partner for the flying.
