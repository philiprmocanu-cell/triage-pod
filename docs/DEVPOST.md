## Inspiration

In Zambia, up to **three in ten clinics ran out of malaria drugs in a quarter while the national warehouse had plenty** (PLOS ONE 2016, 145 facilities). The country's own plan puts only 35% of primary facilities fully stocked. Half of rural households live more than 5 km from any facility, and in the rainy season whole villages are cut off for weeks. The medicine exists. It just never reaches the village, and nobody at the village can say what is needed.

We wanted to build the missing link: a pod in every village that can tell what a patient needs, and a distribution brain that moves exactly that, on the roads that are actually open, before the rains close them.

## What it does

**Triage Pod** is three layers that run on one live database.

1. **The pod.** A box with a camera, a microphone, a speaker and a finger pulse-oximeter at every health post. A patient sits down and talks in their own language. The pod asks like a nurse (danger signs first, then the history, then the questions that matter for what it heard), reads the camera for signs like a hand on the chest or a yellowed eye, and names a condition only when the evidence is strong. It orders exactly what that condition needs: a malaria test and ACT, not a guess. It learns the village's own words ("running stomach") and, with consent, the village's own voice.
2. **The map.** Every order becomes a delivery in the patient's name, shipped from wherever the stock actually is (the post's shelf, a neighbouring post with surplus, or the Chipata hub) on one of Zambia's real carriers (ZAMMSA hub trucks, district pickups, community-health-worker motorbikes, bicycles, Luangwa banana boats) along the real road, drawn live on a globe with **23,206 villages and hamlets** found by counting 4.3 million roofs in satellite imagery.
3. **The distribution brain.** Satellites feed it: 16-day rain forecasts, Copernicus river-flood forecasts, NASA's three-day flood map read pixel by pixel around every road, ten years of daily rain per post (so it knows Katete's roads usually close from 13 January), and the 4–8-week lag between rain and malaria. It ranks shipments (emergency, pod requests, pre-positioning before a closure, outbreak top-ups, routine runs), batches them into multi-stop truck runs, checks every leg for flooding and road surface, re-routes around blocked crossings, switches to a motorbike or boat when no road is dry, and re-checks every route every ten minutes.

Two more pieces: a **mosquito listener** (Oxford's HumBug wingbeat models) that names the species it hears and raises a village's malaria likelihood when the malaria carrier is around, and **Tracks**, which proposes motorbike and bicycle tracks from satellite terrain to villages that have no road at all.

The **Crisis** tab runs the hard case live: a rainy-season week with 26 posts in need at once, 46 empty shelves, both Luangwa crossings under water and three vehicles down. In about thirty seconds the planner turns 841 orders into **83 vehicle movements instead of 833**, has posts lend to posts, and sends boats and motorbikes where roads are cut: **112,849 km and 2,044 driving hours saved** against one-trip-per-order.

## How we built it

- **Next.js 15 + TypeScript**, one app, 22 screens, 24 API routes.
- **SpacetimeDB** holds everything live: villages, stock, visits, orders, carriers, route plans, pod presence, road blocks, the crisis itself. Every screen subscribes; nothing is polled from a file.
- **Jev (TypeSafe)** makes every clinical decision: it reads the whole transcript and 61 camera traits per burst and scores findings; the nurse logic (danger signs first, max seven steps, hard safety rules in code) decides what to ask next. **Claude** only words the sentences and gives a second opinion on high-stakes camera signs. **Cartesia** does speech in and out, with a learned voice per village.
- **Free satellite and map data, no keys:** NASA POWER, Open-Meteo (forecast and ten-year archive), Copernicus GloFAS and DEM, ESA WorldCover, Sentinel-2, NASA GIBS flood maps, Google Open Buildings, GeoNames, OpenStreetMap roads via OSRM.
- **Hardware:** Seeed XIAO nRF52840 with a MAX30101 finger sensor and a Grove Vision AI V2 camera, both over USB to the laptop; firmware written and tested on the real boards.
- **Mosquitoes:** HumBug MozzBNN (MIT) models for mosquito detection and 8-species classification, run locally in Python.
- **Terrain tracks:** 30 m elevation and 10 m land cover turned into a per-vehicle cost map; least-cost paths to every roof cluster within 15 km of a post.

## Challenges we ran into

- **Making the pod stop asking.** Early versions asked forever or asked the wrong thing. We rebuilt the flow around how a nurse works: what brought you in, open only the matching areas, a hard cap of questions, and a clear ending with "nothing found" as a real outcome.
- **False alarms from the camera.** One lopsided frame behind a hand once produced "is one side of your face drooping?". Now a serious sign must persist for three bursts under even lighting, the smile test runs before any stroke question, and Claude looks at the same frames as a second opinion.
- **Satellite data that lies.** NASA's preliminary rainfall showed 450 mm in a dry-season week; we cross-check against the finished record from the same weeks last year and say "preliminary" on screen.
- **No Overpass, no Zipline, no drone fleet.** OpenStreetMap's query servers refused us all night, so roads come from OSRM geometries and surfaces from the OSM node API. And no drone operator flies in Zambia yet, so drones are labelled "proposed partner" and the planner only reaches for one when nothing on the ground can carry the load.
- **Speed.** A turn took sixteen seconds; it now takes about three: one mic stream per visit, streamed speech, cached fixed questions, and Claude drafting while Jev reads.

## What we learned

The hard part was never the model. It was deciding what the model is allowed to decide. The rapid test still decides malaria; the pod only moves the starting guess. A satellite can say an area is wet, not that a culvert is out; the badge means "call the district driver". Every time we wrote that limit on the screen instead of hiding it, the product got more believable, not less.

## What's next

Wire the terrain tracks into the planner so a cut-off post is really routed off-road; add Chewa/Nyanja voices; a nurse's red pen on every verdict; a second pilot province. And a real partner for the flying.
